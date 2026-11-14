import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Automatic local-AI bootstrap: install Ollama (Windows: signed installer, per-user, no admin),
 * start it, and pull a Google Gemma model. Shared by the server (/api/setup/*) and the
 * `npm run setup:gemma` CLI. Nothing here ever contacts a paid/cloud AI service: the only
 * network traffic is downloading the official Ollama installer and the Gemma weights.
 */

export const OLLAMA_BASE = 'http://127.0.0.1:11434';
export const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
// The installer URL redirects to the release CDN; refuse any other final host.
const INSTALLER_HOST_ALLOWLIST = [/(^|\.)ollama\.com$/, /(^|\.)github\.com$/, /(^|\.)githubusercontent\.com$/];

/** Only Google Gemma-family tags may be pulled through this feature. */
const GEMMA_TAG_RE = /^[a-z0-9]*gemma[a-z0-9]*:[a-z0-9._-]{1,32}$/;
export function isAllowedGemmaTag(tag: unknown): tag is string {
  return typeof tag === 'string' && tag.length <= 48 && GEMMA_TAG_RE.test(tag);
}

/** Conservative pick: never auto-selects the very large models on unknown hardware. */
export function recommendModel(totalMemBytes: number): string {
  const gib = totalMemBytes / 2 ** 30;
  return gib < 7 ? 'gemma4:e2b' : 'gemma4:e4b';
}

export type SetupPhase =
  | 'idle'
  | 'checking'
  | 'downloading-installer'
  | 'verifying'
  | 'installing'
  | 'starting-ollama'
  | 'pulling-model'
  | 'done'
  | 'error';

export interface SetupState {
  phase: SetupPhase;
  message: string;
  percent: number | null;
  model: string;
  running: boolean;
  error?: string;
  /** Actionable manual fallback when automation cannot proceed. */
  manualHint?: string;
  log: string[];
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  totalMemGiB: number;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  ollamaPath: string | null;
  ollamaOnPath: boolean;
  installedModels: string[];
  recommendedModel: string;
}

export interface EnsurePathResult {
  binDir: string;
  alreadyInProcessPath: boolean;
  addedToProcessPath: boolean;
  addedToUserEnv: boolean;
  updatedProfiles: string[];
}

// ---------- low-level helpers (all injectable for tests) ----------

export function findOllamaBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const exe = platform === 'win32' ? 'ollama.exe' : 'ollama';
  const candidates: string[] = [];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', exe));
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Ollama', exe));
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama'
    );
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
  const unquoted = entry.trim().replace(/^"(.*)"$/, '$1');
  const trimmed = unquoted.replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function isDirInPath(
  dir: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  const target = normalizePathEntry(dir, platform);
  if (!target || !pathValue) return false;
  const sep = platform === 'win32' ? ';' : ':';
  return pathValue
    .split(sep)
    .some((part) => normalizePathEntry(part, platform) === target);
}

export function appendDirToPathValue(
  currentPath: string | undefined,
  dir: string,
  platform: NodeJS.Platform = process.platform
): { updated: string; changed: boolean } {
  const sep = platform === 'win32' ? ';' : ':';
  const cleanDir = dir.trim();
  if (!cleanDir) return { updated: currentPath || '', changed: false };
  if (isDirInPath(cleanDir, currentPath, platform)) {
    return { updated: currentPath || '', changed: false };
  }
  const existing = (currentPath || '').trim();
  if (!existing) return { updated: cleanDir, changed: true };
  const needsSep = !existing.endsWith(sep);
  return { updated: `${existing}${needsSep ? sep : ''}${cleanDir}`, changed: true };
}

export function toPosixPath(winPath: string): string {
  const match = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return winPath.replace(/\\/g, '/');
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function readWindowsEnvPaths(): { userPath: string; machinePath: string } | null {
  const script =
    '[pscustomobject]@{ ' +
    "User = [Environment]::GetEnvironmentVariable('Path', 'User'); " +
    "Machine = [Environment]::GetEnvironmentVariable('Path', 'Machine') " +
    '} | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse((r.stdout || '').trim()) as {
      User?: string | null;
      Machine?: string | null;
    };
    return { userPath: parsed.User || '', machinePath: parsed.Machine || '' };
  } catch {
    return null;
  }
}

function writeWindowsUserPath(nextUserPath: string): boolean {
  const script = "[Environment]::SetEnvironmentVariable('Path', $env:GV_USER_PATH, 'User')";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, GV_USER_PATH: nextUserPath },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  return r.status === 0;
}

const PROFILE_MARKER = '# >>> GemmaVault Ollama PATH >>>';
const PROFILE_END = '# <<< GemmaVault Ollama PATH <<<';

function updateShellProfile(profileFile: string, posixDir: string): boolean {
  let content = '';
  try {
    content = fs.readFileSync(profileFile, 'utf8');
  } catch {
    return false;
  }
  if (content.includes(PROFILE_MARKER) || content.includes(posixDir)) {
    return false;
  }
  const safeDir = posixDir.replace(/"/g, '\\"');
  const block =
    `\n${PROFILE_MARKER}\n` +
    `if [ -d "${safeDir}" ]; then\n` +
    `  case ":$PATH:" in\n` +
    `    *":${safeDir}:"*) ;;\n` +
    `    *) export PATH="$PATH:${safeDir}" ;;\n` +
    `  esac\n` +
    `fi\n` +
    `${PROFILE_END}\n`;
  fs.writeFileSync(profileFile, `${content}${content.endsWith('\n') || !content ? '' : '\n'}${block}`, 'utf8');
  return true;
}

export interface EnsurePathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readWinPaths?: () => { userPath: string; machinePath: string } | null;
  writeWinUserPath?: (nextUserPath: string) => boolean;
}

/**
 * Ensures the directory containing the Ollama binary is configured on PATH:
 * - Updates the current Node process env immediately.
 * - On Windows, appends to persistent HKCU User PATH (without setx 1024-char truncation)
 *   if absent from both User and Machine PATH.
 * - Updates existing shell profile files (.bashrc / .bash_profile / .zshrc / .profile),
 *   or creates ~/.bashrc on Git Bash when running under MSYSTEM without a bashrc yet.
 */
export function ensureOllamaOnPath(
  binPath: string,
  opts: EnsurePathOptions = {}
): EnsurePathResult {
  const platform = opts.platform ?? process.platform;
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const binDir = pathImpl.dirname(binPath);

  const currentProcPath = env.PATH || env.Path || '';
  const alreadyInProcessPath = isDirInPath(binDir, currentProcPath, platform);
  let addedToProcessPath = false;

  if (!alreadyInProcessPath) {
    const { updated, changed } = appendDirToPathValue(currentProcPath, binDir, platform);
    if (changed) {
      env.PATH = updated;
      if (platform === 'win32') env.Path = updated;
      addedToProcessPath = true;
    }
  }

  let addedToUserEnv = false;
  if (platform === 'win32') {
    const readPaths = opts.readWinPaths ?? readWindowsEnvPaths;
    const writePath = opts.writeWinUserPath ?? writeWindowsUserPath;
    const winPaths = readPaths();
    if (
      winPaths &&
      !isDirInPath(binDir, winPaths.userPath, 'win32') &&
      !isDirInPath(binDir, winPaths.machinePath, 'win32')
    ) {
      const { updated, changed } = appendDirToPathValue(winPaths.userPath, binDir, 'win32');
      if (changed && writePath(updated)) {
        addedToUserEnv = true;
      }
    }
  }

  const updatedProfiles: string[] = [];
  const needsProfileCheck = !alreadyInProcessPath || addedToUserEnv;
  if (needsProfileCheck && homeDir) {
    const posixDir = platform === 'win32' ? toPosixPath(binDir) : binDir;
    const candidates =
      platform === 'win32'
        ? ['.bashrc', '.bash_profile', '.profile']
        : ['.zshrc', '.bashrc', '.bash_profile', '.profile'];

    if (platform === 'win32' && env.MSYSTEM) {
      const bashrc = path.join(homeDir, '.bashrc');
      if (!fs.existsSync(bashrc)) {
        try {
          fs.writeFileSync(bashrc, '', 'utf8');
        } catch {
          /* ignore read-only home */
        }
      }
    }

    for (const name of candidates) {
      const target = path.join(homeDir, name);
      if (fs.existsSync(target) && updateShellProfile(target, posixDir)) {
        updatedProfiles.push(target);
      }
    }
  }

  return {
    binDir,
    alreadyInProcessPath,
    addedToProcessPath,
    addedToUserEnv,
    updatedProfiles,
  };
}

export async function listInstalledModels(base = OLLAMA_BASE): Promise<string[] | null> {
  try {
    const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { models?: Array<{ name?: string }> };
    return (data.models || []).map((m) => m.name || '').filter(Boolean);
  } catch {
    return null; // null === API not reachable
  }
}

async function sleep(ms: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('Setup cancelled.'));
    });
  });
}

async function downloadInstaller(
  dest: string,
  onProgress: (pct: number | null) => void,
  signal: AbortSignal
): Promise<void> {
  const resp = await fetch(OLLAMA_INSTALLER_URL, { signal, redirect: 'follow' });
  const finalHost = new URL(resp.url || OLLAMA_INSTALLER_URL).hostname.toLowerCase();
  if (!INSTALLER_HOST_ALLOWLIST.some((re) => re.test(finalHost))) {
    throw new Error(`Installer download redirected to an unexpected host (${finalHost}); aborting.`);
  }
  if (!resp.ok || !resp.body) throw new Error(`Installer download failed (HTTP ${resp.status}).`);
  const total = Number(resp.headers.get('content-length')) || 0;
  let received = 0;
  const source = Readable.fromWeb(resp.body as import('node:stream/web').ReadableStream);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null);
  });
  await pipeline(source, fs.createWriteStream(dest), { signal });
}

/** Windows only: require a valid Authenticode signature whose subject mentions Ollama. */
export function verifyInstallerSignature(file: string): { ok: boolean; detail: string } {
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:GV_FILE; ' +
    '[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, GV_FILE: file },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  try {
    const parsed = JSON.parse((r.stdout || '').trim()) as { Status: string; Subject: string };
    const ok = parsed.Status === 'Valid' && /ollama/i.test(parsed.Subject || '');
    return { ok, detail: `signature ${parsed.Status}; signer ${parsed.Subject || 'unknown'}` };
  } catch {
    return { ok: false, detail: 'could not read installer signature' };
  }
}

function runInstaller(file: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Ollama's Windows installer is Inno Setup based and installs per-user (no admin prompt).
    const child = spawn(file, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Ollama installer timed out after 10 minutes.'));
    }, 10 * 60_000);
    signal.addEventListener('abort', () => {
      child.kill();
      reject(new Error('Setup cancelled.'));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Ollama installer exited with code ${code}.`));
    });
  });
}

function spawnOllamaServe(bin: string) {
  const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

export async function pullModel(
  tag: string,
  onProgress: (status: string, pct: number | null) => void,
  signal: AbortSignal,
  base = OLLAMA_BASE
): Promise<void> {
  const resp = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tag, stream: true }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(
      `Ollama refused the pull (HTTP ${resp.status}): ${await resp.text().catch(() => '')}`
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        status?: string;
        error?: string;
        total?: number;
        completed?: number;
      };
      if (msg.error) throw new Error(msg.error);
      const pct = msg.total ? Math.round(((msg.completed || 0) / msg.total) * 100) : null;
      onProgress(msg.status || 'pulling', pct);
    }
  }
}

// ---------- orchestration ----------

export interface SetupDeps {
  platform: NodeJS.Platform;
  totalMem: () => number;
  findBinary: () => string | null;
  ensureOnPath: (binPath: string) => EnsurePathResult;
  listModels: () => Promise<string[] | null>;
  installOllama: (
    onPhase: (phase: SetupPhase, message: string, pct: number | null) => void,
    signal: AbortSignal
  ) => Promise<void>;
  startServe: (bin: string) => void;
  pull: (
    tag: string,
    onProgress: (status: string, pct: number | null) => void,
    signal: AbortSignal
  ) => Promise<void>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function defaultInstall(
  onPhase: (phase: SetupPhase, message: string, pct: number | null) => void,
  signal: AbortSignal
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemmavault-setup-'));
  const file = path.join(dir, 'OllamaSetup.exe');
  try {
    onPhase('downloading-installer', 'Downloading the official Ollama installer…', 0);
    await downloadInstaller(
      file,
      (p) => onPhase('downloading-installer', 'Downloading the official Ollama installer…', p),
      signal
    );
    onPhase('verifying', 'Verifying the installer’s digital signature…', null);
    const sig = verifyInstallerSignature(file);
    if (!sig.ok) {
      throw new Error(`Installer signature check failed (${sig.detail}). Nothing was installed.`);
    }
    onPhase('installing', 'Installing Ollama (silent, current user)…', null);
    await runInstaller(file, signal);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const defaultDeps: SetupDeps = {
  platform: process.platform,
  totalMem: () => os.totalmem(),
  findBinary: () => findOllamaBinary(),
  ensureOnPath: (binPath) => ensureOllamaOnPath(binPath),
  listModels: () => listInstalledModels(),
  installOllama: defaultInstall,
  startServe: spawnOllamaServe,
  pull: (tag, onProgress, signal) => pullModel(tag, onProgress, signal),
  sleep,
};

export function manualInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'Download and run the installer from https://ollama.com/download/windows, then click “Auto-setup” again.';
  }
  if (platform === 'darwin') {
    return 'Install from https://ollama.com/download/mac (or `brew install --cask ollama`), then run setup again.';
  }
  return 'Run `curl -fsSL https://ollama.com/install.sh | sh` in a terminal (needs sudo), then run setup again.';
}

export function createSetupManager(deps: SetupDeps = defaultDeps) {
  let state: SetupState = {
    phase: 'idle',
    message: 'Not started.',
    percent: null,
    model: recommendModel(deps.totalMem()),
    running: false,
    log: [],
  };
  let controller: AbortController | null = null;

  const set = (patch: Partial<SetupState>) => {
    state = { ...state, ...patch };
  };
  const note = (line: string) => {
    state = { ...state, log: [...state.log.slice(-39), line] };
  };

  async function waitForApi(signal: AbortSignal, seconds: number): Promise<boolean> {
    for (let i = 0; i < seconds; i++) {
      if ((await deps.listModels()) !== null) return true;
      await deps.sleep(1000, signal);
    }
    return false;
  }

  async function run(model: string, signal: AbortSignal) {
    set({ phase: 'checking', message: 'Checking for Ollama…', percent: null });
    let bin = deps.findBinary();
    let models = await deps.listModels();

    if (!bin && models === null) {
      if (deps.platform !== 'win32') {
        set({ manualHint: manualInstallHint(deps.platform) });
        throw new Error('Ollama is not installed and cannot be installed automatically on this platform.');
      }
      note('Ollama not found — installing.');
      await deps.installOllama((phase, message, percent) => set({ phase, message, percent }), signal);
      for (let i = 0; i < 15 && !bin; i++) {
        bin = deps.findBinary();
        if (!bin) await deps.sleep(1000, signal);
      }
      if (!bin) throw new Error('Installer finished but ollama.exe was not found.');
      note('Ollama installed.');
      models = await deps.listModels();
    }

    if (bin) {
      const pathRes = deps.ensureOnPath(bin);
      if (pathRes.addedToUserEnv) {
        note(`Added ${pathRes.binDir} to Windows User PATH.`);
      }
      if (pathRes.updatedProfiles.length > 0) {
        note(`Updated shell profile: ${pathRes.updatedProfiles.join(', ')}`);
      }
    }

    if (models === null) {
      set({ phase: 'starting-ollama', message: 'Starting the local Ollama service…', percent: null });
      if (!bin) throw new Error('Ollama service is not running and no binary was found to start it.');
      deps.startServe(bin);
      if (!(await waitForApi(signal, 30))) throw new Error('Ollama did not start within 30 seconds.');
      models = (await deps.listModels()) || [];
    }

    if (models.includes(model)) {
      note(`${model} is already installed.`);
    } else {
      set({
        phase: 'pulling-model',
        message: `Downloading ${model} (one-time, then fully offline)…`,
        percent: 0,
      });
      await deps.pull(
        model,
        (status, pct) => set({ message: `${model}: ${status}`, percent: pct }),
        signal
      );
    }
    set({
      phase: 'done',
      message: `${model} is ready. GemmaVault now runs fully offline.`,
      percent: 100,
    });
  }

  return {
    getState: (): SetupState => state,
    async getSystemInfo(): Promise<SystemInfo> {
      const [models, bin] = await Promise.all([deps.listModels(), Promise.resolve(deps.findBinary())]);
      const pathImpl = deps.platform === 'win32' ? path.win32 : path.posix;
      const ollamaOnPath = Boolean(
        bin && isDirInPath(pathImpl.dirname(bin), process.env.PATH || process.env.Path, deps.platform)
      );
      return {
        platform: deps.platform,
        totalMemGiB: Math.round((deps.totalMem() / 2 ** 30) * 10) / 10,
        ollamaInstalled: Boolean(bin) || models !== null,
        ollamaRunning: models !== null,
        ollamaPath: bin,
        ollamaOnPath,
        installedModels: models || [],
        recommendedModel: recommendModel(deps.totalMem()),
      };
    },
    /** Starts setup in the background; resolves once the job is registered. */
    start(model?: string): SetupState {
      if (state.running) throw new Error('Setup is already running.');
      const tag = model ?? recommendModel(deps.totalMem());
      if (!isAllowedGemmaTag(tag)) throw new Error('Only Google Gemma model tags can be installed.');
      controller = new AbortController();
      const { signal } = controller;
      state = {
        phase: 'checking',
        message: 'Starting…',
        percent: null,
        model: tag,
        running: true,
        log: [],
      };
      void run(tag, signal)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          set({ phase: 'error', message, error: message, percent: null });
        })
        .finally(() => {
          set({ running: false });
          controller = null;
        });
      return state;
    },
    /** Test/CLI helper: start and wait for completion. */
    async runToCompletion(model?: string): Promise<SetupState> {
      this.start(model);
      while (state.running) await deps.sleep(250);
      return state;
    },
    cancel() {
      controller?.abort();
    },
  };
}

export type SetupManager = ReturnType<typeof createSetupManager>;

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
  installedModels: string[];
  recommendedModel: string;
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
      const models = await deps.listModels();
      return {
        platform: deps.platform,
        totalMemGiB: Math.round((deps.totalMem() / 2 ** 30) * 10) / 10,
        ollamaInstalled: Boolean(deps.findBinary()) || models !== null,
        ollamaRunning: models !== null,
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

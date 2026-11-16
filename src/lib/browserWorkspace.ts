import {
  IgnoreMatcher,
  LIMITS,
  WorkspaceError,
  bm25Search,
  buildBm25,
  buildFileChunks,
  dotProduct,
  embedTexts,
  extractImports,
  extractSymbols,
  fuseRanks,
  isBinaryName,
  isDeniedName,
  isDeniedPath,
  isLoopbackHttpUrl,
  languageOf,
  looksBinaryBytes,
  redactSecrets,
  renderRepoMap,
  scorePath,
  vecKey,
  type Bm25Index,
  type Chunk,
  type FileEntry,
  type ScanResult,
} from './workspaceCore';
import type { WorkspaceConnectionLike } from './workspaceClient';
import type {
  EmbeddingSetting,
  FileListResult,
  FileRead,
  GitOp,
  GitResult,
  RepoMapResult,
  SearchHit,
  SearchMode,
  SearchResult,
  SymbolHit,
  TreeEntry,
  WorkspaceInfo,
} from '../types/workspace';

export type BrowserPermissionState = 'granted' | 'denied' | 'prompt';

export interface BrowserFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface BrowserDirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, BrowserDirHandle | BrowserFileHandle]>;
  getFileHandle(name: string): Promise<BrowserFileHandle>;
  getDirectoryHandle(name: string): Promise<BrowserDirHandle>;
  queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<BrowserPermissionState>;
  requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<BrowserPermissionState>;
}

interface SnapshotEntry {
  name: string;
  rawFiles: File[];
}

interface BrowserWorkspaceState {
  root: string;
  name: string;
  handle?: BrowserDirHandle;
  snapshotFiles?: Map<string, File>;
  scan: ScanResult;
  bm25: Bm25Index;
  scannedAt: number;
  vectors: Map<string, Float32Array>;
  embed: {
    setting: EmbeddingSetting | null;
    state: 'idle' | 'running' | 'error' | 'off';
    error?: string;
    token: number;
  };
}

const REFRESH_AFTER_MS = 20_000;
const MAX_EMBED_CHUNKS = 4000;
const EMBED_BATCH = 16;
const HANDLE_DB = 'GemmaVaultFSHandles';
const HANDLE_STORE = 'handles';

const handleRegistry = new Map<string, BrowserDirHandle>();
const snapshotRegistry = new Map<string, SnapshotEntry>();
const browserStates = new Map<string, BrowserWorkspaceState>();

export function isBrowserWorkspacePath(rawPath: string): boolean {
  return rawPath.startsWith('fsa:');
}

export function isBrowserSnapshotPath(rawPath: string): boolean {
  return rawPath.startsWith('fsa:snap-');
}

export function parseBrowserWorkspaceName(rawPath: string): string {
  if (!isBrowserWorkspacePath(rawPath)) {
    const cleaned = rawPath.replace(/[\\/]+$/, '');
    const parts = cleaned.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || cleaned || 'workspace';
  }
  const idx = rawPath.indexOf(':', 4);
  if (idx < 0) return rawPath.slice(4) || 'project';
  try {
    return decodeURIComponent(rawPath.slice(idx + 1)) || 'project';
  } catch {
    return rawPath.slice(idx + 1) || 'project';
  }
}

export function supportsBrowserDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

/** True when running inside a cross-origin iframe (where Chromium blocks showDirectoryPicker()). */
export function isCrossOriginSubframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.self === window.top) return false;
    void window.top?.location?.href;
    return false;
  } catch {
    return true;
  }
}

export function supportsWebkitDirectoryInput(): boolean {
  if (typeof document === 'undefined') return false;
  const input = document.createElement('input');
  return 'webkitdirectory' in input || 'mozdirectory' in input;
}

let directPickerBlocked = false;

export function canUseDirectDirectoryPicker(): boolean {
  return !directPickerBlocked && supportsBrowserDirectoryPicker() && !isCrossOriginSubframe();
}

export function supportsBrowserFolderAccess(): boolean {
  return canUseDirectDirectoryPicker() || supportsWebkitDirectoryInput();
}

// ---- lightweight IndexedDB persistence for FileSystemDirectoryHandle objects --------------------
// Note: Only the opaque directory handle reference (no file contents or search index) is stored.

function openHandleDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveHandle(key: string, handle: BrowserDirHandle): Promise<void> {
  const db = await openHandleDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put({ key, handle });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Non-fatal in restricted or non-cloneable test environments.
  } finally {
    db.close();
  }
}

async function loadHandle(key: string): Promise<BrowserDirHandle | null> {
  const db = await openHandleDb();
  if (!db) return null;
  try {
    return await new Promise<BrowserDirHandle | null>((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(key);
      req.onsuccess = () => {
        const row = req.result as { handle?: BrowserDirHandle } | undefined;
        resolve(row?.handle ?? null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function deleteHandle(key: string): Promise<void> {
  const db = await openHandleDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  } finally {
    db.close();
  }
}

function makeBrowserKey(prefix: string, name: string): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `fsa:${prefix}${id}:${encodeURIComponent(name || 'project')}`;
}

export async function registerBrowserDirectoryHandle(
  handle: BrowserDirHandle,
  customKey?: string
): Promise<string> {
  const key = customKey ?? makeBrowserKey('', handle.name);
  handleRegistry.set(key, handle);
  await saveHandle(key, handle);
  return key;
}

export function registerBrowserFileSnapshot(
  files: FileList | File[],
  fallbackName = 'project'
): { root: string; name: string } {
  const rawFiles = Array.from(files);
  const firstRel = (rawFiles[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || rawFiles[0]?.name || '';
  const topSeg = firstRel.replace(/\\/g, '/').split('/').filter(Boolean)[0];
  const name = topSeg && rawFiles.some((f) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || '').includes('/'))
    ? topSeg
    : fallbackName;
  const root = makeBrowserKey('snap-', name);
  snapshotRegistry.set(root, { name, rawFiles });
  return { root, name };
}

export async function pickBrowserWorkspaceDirectory(): Promise<{ root: string; name: string }> {
  if (!canUseDirectDirectoryPicker()) {
    throw new WorkspaceError(
      'Direct folder picker is unavailable in this frame. Choose a folder via browser upload picker instead.',
      400
    );
  }
  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<BrowserDirHandle>;
    }
  ).showDirectoryPicker;
  try {
    const handle = await picker({ mode: 'read' });
    const root = await registerBrowserDirectoryHandle(handle);
    return { root, name: handle.name || parseBrowserWorkspaceName(root) };
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'SecurityError') {
      directPickerBlocked = true;
      throw new WorkspaceError(
        'Direct folder picker is blocked in this embedded frame. Click Open project folder again to use browser folder selection.',
        403
      );
    }
    throw err;
  }
}

async function resolveHandle(root: string): Promise<BrowserDirHandle | null> {
  const mem = handleRegistry.get(root);
  if (mem) return mem;
  const stored = await loadHandle(root);
  if (stored) handleRegistry.set(root, stored);
  return stored;
}

async function checkReadPermission(handle: BrowserDirHandle, allowPrompt: boolean): Promise<void> {
  if (typeof handle.queryPermission !== 'function') return;
  const state = await handle.queryPermission({ mode: 'read' });
  if (state === 'granted') return;
  if (state === 'denied') {
    throw new WorkspaceError('Folder read access was denied by the browser.', 403);
  }
  if (allowPrompt && typeof handle.requestPermission === 'function') {
    const requested = await handle.requestPermission({ mode: 'read' });
    if (requested === 'granted') return;
  }
  throw new WorkspaceError('Browser folder permission needed. Click Grant access to reconnect.', 403);
}

/** Must be invoked from a direct user gesture (click) to prompt for permission on a reloaded tab. */
export async function requestBrowserWorkspaceAccess(root: string): Promise<boolean> {
  const handle = await resolveHandle(root);
  if (!handle) {
    throw new WorkspaceError('Select this project folder again to index it in this browser tab.', 409);
  }
  await checkReadPermission(handle, true);
  return true;
}

export function clearBrowserWorkspaceCache(): void {
  handleRegistry.clear();
  snapshotRegistry.clear();
  browserStates.clear();
}

// ---- scanning & path safety inside BrowserDirHandle / webkitdirectory snapshots ----------------

async function readIgnoreFromHandle(dirHandle: BrowserDirHandle, m: IgnoreMatcher): Promise<void> {
  for (const name of ['.gitignore', '.gemmaignore']) {
    try {
      const fh = await dirHandle.getFileHandle(name);
      const file = await fh.getFile();
      if (file.size < 200_000) m.add(await file.text());
    } catch {
      // no ignore file in this folder
    }
  }
}

async function scanBrowserDirectory(
  rootHandle: BrowserDirHandle,
  opts: { previous?: ScanResult; signal?: AbortSignal } = {}
): Promise<ScanResult> {
  const files = new Map<string, FileEntry>();
  const dirs = new Set<string>();
  const chunks: Chunk[] = [];
  let totalBytes = 0;
  let indexedBytes = 0;
  let truncated = false;

  const rootIgnore = new IgnoreMatcher();
  await readIgnoreFromHandle(rootHandle, rootIgnore);

  type Frame = {
    handle: BrowserDirHandle;
    rel: string;
    depth: number;
    ignores: Array<{ base: string; m: IgnoreMatcher }>;
  };
  const stack: Frame[] = [{ handle: rootHandle, rel: '', depth: 0, ignores: [{ base: '', m: rootIgnore }] }];

  while (stack.length > 0) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const frame = stack.pop()!;
    const rawEntries: Array<{ name: string; handle: BrowserDirHandle | BrowserFileHandle }> = [];
    try {
      for await (const [name, handle] of frame.handle.entries()) {
        rawEntries.push({ name, handle });
      }
    } catch {
      continue;
    }
    rawEntries.sort((a, b) => a.name.localeCompare(b.name));
    const subDirs: Frame[] = [];

    for (const { name, handle } of rawEntries) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const isDir = handle.kind === 'directory';
      if (isDeniedName(name, isDir)) continue;
      const rel = frame.rel ? `${frame.rel}/${name}` : name;
      if (frame.ignores.some(({ base, m }) => m.ignores(base ? rel.slice(base.length + 1) : rel, isDir))) continue;

      if (isDir) {
        if (frame.depth + 1 > LIMITS.maxDepth) {
          truncated = true;
          continue;
        }
        dirs.add(rel);
        const ignores = [...frame.ignores];
        const local = new IgnoreMatcher();
        await readIgnoreFromHandle(handle as BrowserDirHandle, local);
        ignores.push({ base: rel, m: local });
        subDirs.push({ handle: handle as BrowserDirHandle, rel, depth: frame.depth + 1, ignores });
        continue;
      }

      if (files.size >= LIMITS.maxFiles) {
        truncated = true;
        continue;
      }

      let file: File;
      try {
        file = await (handle as BrowserFileHandle).getFile();
      } catch {
        continue;
      }
      totalBytes += file.size;
      const language = languageOf(rel);
      const entry: FileEntry = {
        path: rel,
        size: file.size,
        mtimeMs: file.lastModified || 0,
        language,
        indexed: false,
        lineCount: 0,
        imports: [],
        symbols: [],
      };
      files.set(rel, entry);

      if (isBinaryName(rel) || file.size > LIMITS.maxIndexBytes || file.size === 0) continue;
      if (indexedBytes + file.size > LIMITS.maxTotalIndexBytes) {
        truncated = true;
        continue;
      }

      const fileKey = `${file.size}:${Math.floor(entry.mtimeMs)}`;
      const prev = opts.previous?.files.get(rel);
      let content: string;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (looksBinaryBytes(bytes)) continue;
        content = new TextDecoder('utf-8').decode(bytes);
      } catch {
        continue;
      }

      indexedBytes += file.size;
      entry.indexed = true;
      entry.lineCount = content.split('\n').length;
      const redacted = redactSecrets(content).text;
      if (prev && prev.indexed && `${prev.size}:${Math.floor(prev.mtimeMs)}` === fileKey) {
        entry.symbols = prev.symbols;
        entry.imports = prev.imports;
      } else {
        entry.symbols = extractSymbols(rel, language, redacted);
        entry.imports = extractImports(language, redacted);
      }
      for (const c of buildFileChunks(entry, fileKey, redacted)) chunks.push(c);
    }

    for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i]);
  }

  chunks.forEach((c, i) => (c.id = i));
  return { files, chunks, totalBytes, truncated, dirs };
}

async function scanBrowserFileSnapshot(
  rawFiles: File[],
  rootName: string,
  signal?: AbortSignal
): Promise<{ scan: ScanResult; snapshotFiles: Map<string, File> }> {
  const files = new Map<string, FileEntry>();
  const dirs = new Set<string>();
  const chunks: Chunk[] = [];
  const snapshotFiles = new Map<string, File>();
  let totalBytes = 0;
  let indexedBytes = 0;
  let truncated = false;

  const normalized: Array<{ rel: string; file: File }> = [];
  const rootPrefix = rootName ? `${rootName}/` : '';

  for (const file of rawFiles) {
    const rawRel = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    const rel = rootPrefix && rawRel.startsWith(rootPrefix) ? rawRel.slice(rootPrefix.length) : rawRel;
    if (!rel) continue;
    normalized.push({ rel, file });
  }
  normalized.sort((a, b) => a.rel.localeCompare(b.rel));

  // Build per-directory .gitignore / .gemmaignore matchers before indexing any file.
  const ignoreByDir = new Map<string, IgnoreMatcher>();
  for (const { rel, file } of normalized) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const slash = rel.lastIndexOf('/');
    const base = slash >= 0 ? rel.slice(slash + 1) : rel;
    if (base !== '.gitignore' && base !== '.gemmaignore') continue;
    const dir = slash >= 0 ? rel.slice(0, slash) : '';
    if (dir && isDeniedPath(dir)) continue;
    if (file.size >= 200_000) continue;
    let m = ignoreByDir.get(dir);
    if (!m) {
      m = new IgnoreMatcher();
      ignoreByDir.set(dir, m);
    }
    try {
      m.add(await file.text());
    } catch {
      // ignore unreadable ignore files
    }
  }

  const isIgnored = (rel: string): boolean => {
    const parts = rel.split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      const base = parts.slice(0, depth).join('/');
      const m = ignoreByDir.get(base);
      if (m && m.ignores(parts.slice(depth).join('/'), false)) return true;
    }
    return false;
  };

  for (const { rel, file } of normalized) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (isDeniedPath(rel)) continue;
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length - 1 > LIMITS.maxDepth) {
      truncated = true;
      continue;
    }
    if (isIgnored(rel)) continue;

    // Record ancestor folders
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }

    if (files.size >= LIMITS.maxFiles) {
      truncated = true;
      continue;
    }

    snapshotFiles.set(rel, file);
    totalBytes += file.size;
    const language = languageOf(rel);
    const entry: FileEntry = {
      path: rel,
      size: file.size,
      mtimeMs: file.lastModified || 0,
      language,
      indexed: false,
      lineCount: 0,
      imports: [],
      symbols: [],
    };
    files.set(rel, entry);

    if (isBinaryName(rel) || file.size > LIMITS.maxIndexBytes || file.size === 0) continue;
    if (indexedBytes + file.size > LIMITS.maxTotalIndexBytes) {
      truncated = true;
      continue;
    }

    let content: string;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (looksBinaryBytes(bytes)) continue;
      content = new TextDecoder('utf-8').decode(bytes);
    } catch {
      continue;
    }

    indexedBytes += file.size;
    entry.indexed = true;
    entry.lineCount = content.split('\n').length;
    const fileKey = `${file.size}:${Math.floor(entry.mtimeMs)}`;
    const redacted = redactSecrets(content).text;
    entry.symbols = extractSymbols(rel, language, redacted);
    entry.imports = extractImports(language, redacted);
    for (const c of buildFileChunks(entry, fileKey, redacted)) chunks.push(c);
  }

  chunks.forEach((c, i) => (c.id = i));
  return { scan: { files, chunks, totalBytes, truncated, dirs }, snapshotFiles };
}

function validateSafeRelPath(rel: string): string[] {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new WorkspaceError('Invalid path.');
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
    throw new WorkspaceError('Paths must be relative to the project folder.');
  }
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (parts.length === 0) throw new WorkspaceError('Invalid path.');
  if (parts.includes('..')) throw new WorkspaceError('Path escapes the project folder.', 403);
  if (isDeniedPath(parts.join('/'))) {
    throw new WorkspaceError('That file is excluded from project context (secrets, build output or VCS data).', 403);
  }
  return parts;
}

async function resolveBrowserFile(rootHandle: BrowserDirHandle, rel: string): Promise<{ relReal: string; file: File }> {
  const parts = validateSafeRelPath(rel);
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    try {
      dir = await dir.getDirectoryHandle(parts[i]);
    } catch {
      throw new WorkspaceError('File not found.', 404);
    }
  }
  const name = parts[parts.length - 1];
  try {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return { relReal: parts.join('/'), file };
  } catch {
    try {
      await dir.getDirectoryHandle(name);
      throw new WorkspaceError('That path is a folder; mention it as a folder instead.');
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError('File not found.', 404);
    }
  }
}

// ---- BrowserWorkspaceConnection ----------------------------------------------------------------

export class BrowserWorkspaceConnection implements WorkspaceConnectionLike {
  readonly root: string;
  readonly mode = 'browser' as const;
  private readonly embedding: EmbeddingSetting | null;
  private readonly fetchImpl: typeof fetch;

  constructor(root: string, embedding: EmbeddingSetting | null = null, fetchImpl: typeof fetch = fetch) {
    this.root = root;
    this.embedding = embedding;
    this.fetchImpl = fetchImpl;
  }

  private setEmbedding(st: BrowserWorkspaceState, setting: EmbeddingSetting | null | undefined) {
    const next =
      setting && setting.model.trim() && isLoopbackHttpUrl(setting.baseUrl)
        ? { baseUrl: setting.baseUrl.replace(/\/+$/, ''), model: setting.model.trim() }
        : null;
    const cur = st.embed.setting;
    if (cur?.model === next?.model && cur?.baseUrl === next?.baseUrl) return;
    st.vectors.clear();
    st.embed = { setting: next, state: next ? 'idle' : 'off', token: st.embed.token + 1 };
    if (next) void this.runEmbedding(st);
  }

  private async runEmbedding(st: BrowserWorkspaceState): Promise<void> {
    const setting = st.embed.setting;
    if (!setting || st.embed.state === 'running') return;
    const token = ++st.embed.token;
    st.embed.state = 'running';
    st.embed.error = undefined;
    try {
      const wanted = new Map<string, Chunk>();
      for (const c of st.scan.chunks.slice(0, MAX_EMBED_CHUNKS)) wanted.set(vecKey(c), c);
      for (const k of st.vectors.keys()) if (!wanted.has(k)) st.vectors.delete(k);
      const todo = [...wanted.entries()].filter(([k]) => !st.vectors.has(k));
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        if (st.embed.token !== token || st.embed.setting !== setting) return;
        const batch = todo.slice(i, i + EMBED_BATCH);
        const vecs = await embedTexts(
          setting,
          batch.map(([, c]) => `${c.path}\n${c.text}`.slice(0, 1800)),
          this.fetchImpl
        );
        batch.forEach(([k], j) => st.vectors.set(k, vecs[j]));
      }
      st.embed.state = 'idle';
    } catch (e) {
      st.embed.state = 'error';
      st.embed.error = e instanceof Error ? e.message : 'Embedding failed.';
    }
  }

  private toInfo(st: BrowserWorkspaceState): WorkspaceInfo {
    return {
      rootPath: st.root,
      name: st.name,
      fileCount: st.scan.files.size,
      chunkCount: st.scan.chunks.length,
      totalBytes: st.scan.totalBytes,
      truncated: st.scan.truncated,
      isGit: false,
      indexedAt: st.scannedAt,
      source: 'browser',
      embeddings: {
        model: st.embed.setting?.model ?? '',
        embedded: st.vectors.size,
        total: Math.min(st.scan.chunks.length, MAX_EMBED_CHUNKS),
        state: st.embed.setting ? st.embed.state : 'off',
        error: st.embed.error,
      },
    };
  }

  private async fresh(signal?: AbortSignal): Promise<BrowserWorkspaceState> {
    const st = browserStates.get(this.root);
    if (!st) throw new WorkspaceError('That project folder is not open. Open it first.', 409);
    if (!st.handle || Date.now() - st.scannedAt < REFRESH_AFTER_MS) return st;
    const scan = await scanBrowserDirectory(st.handle, { previous: st.scan, signal });
    st.scan = scan;
    st.bm25 = buildBm25(scan.chunks);
    st.scannedAt = Date.now();
    if (st.embed.setting) void this.runEmbedding(st);
    return st;
  }

  async open(signal?: AbortSignal): Promise<WorkspaceInfo> {
    const snap = snapshotRegistry.get(this.root);
    if (snap) {
      const existing = browserStates.get(this.root);
      const { scan, snapshotFiles } = await scanBrowserFileSnapshot(snap.rawFiles, snap.name, signal);
      const st: BrowserWorkspaceState = {
        root: this.root,
        name: snap.name,
        snapshotFiles,
        scan,
        bm25: buildBm25(scan.chunks),
        scannedAt: Date.now(),
        vectors: existing?.vectors ?? new Map(),
        embed: existing?.embed ?? { setting: null, state: 'off', token: 0 },
      };
      browserStates.set(this.root, st);
      this.setEmbedding(st, this.embedding);
      return this.toInfo(st);
    }

    const handle = await resolveHandle(this.root);
    if (!handle) {
      throw new WorkspaceError('Select this project folder again to re-index its files in this browser tab.', 409);
    }
    await checkReadPermission(handle, false);
    const prev = browserStates.get(this.root);
    const scan = await scanBrowserDirectory(handle, { previous: prev?.scan, signal });
    const st: BrowserWorkspaceState = {
      root: this.root,
      name: handle.name || parseBrowserWorkspaceName(this.root),
      handle,
      scan,
      bm25: buildBm25(scan.chunks),
      scannedAt: Date.now(),
      vectors: prev?.vectors ?? new Map(),
      embed: prev?.embed ?? { setting: null, state: 'off', token: 0 },
    };
    browserStates.set(this.root, st);
    this.setEmbedding(st, this.embedding);
    return this.toInfo(st);
  }

  async close(): Promise<{ ok: boolean }> {
    browserStates.delete(this.root);
    handleRegistry.delete(this.root);
    snapshotRegistry.delete(this.root);
    await deleteHandle(this.root);
    return { ok: true };
  }

  async info(signal?: AbortSignal): Promise<WorkspaceInfo> {
    const st = await this.fresh(signal);
    this.setEmbedding(st, this.embedding);
    return this.toInfo(st);
  }

  async files(query: string, limit = 8, signal?: AbortSignal): Promise<FileListResult> {
    const st = await this.fresh(signal);
    const q = String(query ?? '').trim();
    const lim = Math.max(1, Math.min(30, limit));
    const files = [...st.scan.files.values()]
      .map((f) => ({ f, s: scorePath(f.path, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.f.mtimeMs - a.f.mtimeMs)
      .slice(0, lim)
      .map(({ f }) => ({ path: f.path, size: f.size, language: f.language }));
    const dirs = q
      ? [...st.scan.dirs]
          .map((d) => ({ d, s: scorePath(d, q) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.d.localeCompare(b.d))
          .slice(0, 4)
          .map((x) => x.d)
      : [];
    return { files, dirs };
  }

  async tree(dir = '', depth = 2, signal?: AbortSignal): Promise<TreeEntry[]> {
    const st = await this.fresh(signal);
    const base = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (base) validateSafeRelPath(base);
    const maxDepth = Math.max(1, Math.min(6, depth));
    const prefix = base ? `${base}/` : '';
    const out: TreeEntry[] = [];
    for (const d of [...st.scan.dirs].sort()) {
      if (d.startsWith(prefix) && d.slice(prefix.length).split('/').length <= maxDepth) out.push({ path: d, type: 'dir' });
    }
    for (const f of st.scan.files.values()) {
      if (f.path.startsWith(prefix) && f.path.slice(prefix.length).split('/').length <= maxDepth) out.push({ path: f.path, type: 'file', size: f.size });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 500);
  }

  async read(rel: string, startLine?: number, endLine?: number): Promise<FileRead> {
    const st = browserStates.get(this.root);
    if (!st) throw new WorkspaceError('That project folder is not open. Open it first.', 409);

    let relReal: string;
    let file: File;
    if (st.snapshotFiles) {
      const parts = validateSafeRelPath(rel);
      relReal = parts.join('/');
      const found = st.snapshotFiles.get(relReal);
      if (!found) {
        if (st.scan.dirs.has(relReal)) {
          throw new WorkspaceError('That path is a folder; mention it as a folder instead.');
        }
        throw new WorkspaceError('File not found.', 404);
      }
      file = found;
    } else if (st.handle) {
      const resolved = await resolveBrowserFile(st.handle, rel);
      relReal = resolved.relReal;
      file = resolved.file;
    } else {
      throw new WorkspaceError('That project folder is not open. Open it first.', 409);
    }

    if (file.size > LIMITS.maxReadBytes) {
      throw new WorkspaceError(`File is larger than ${Math.round(LIMITS.maxReadBytes / 1000)} KB; mention a line range or search instead.`, 413);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (looksBinaryBytes(bytes)) throw new WorkspaceError('Binary files cannot be attached.', 415);
    const text = new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/g, '\n');
    const redacted = redactSecrets(text);
    const lines = redacted.text.split('\n');
    const from = Math.max(1, Math.floor(startLine ?? 1));
    const to = Math.min(lines.length, Math.floor(endLine ?? lines.length));
    if (from > lines.length) throw new WorkspaceError('Line range is past the end of the file.');
    return {
      path: relReal,
      language: languageOf(relReal),
      content: lines.slice(from - 1, Math.max(from, to)).join('\n'),
      startLine: from,
      endLine: Math.max(from, to),
      totalLines: lines.length,
      truncated: from > 1 || to < lines.length,
      redactions: redacted.count,
    };
  }

  async symbols(query: string, limit = 6, signal?: AbortSignal): Promise<SymbolHit[]> {
    const st = await this.fresh(signal);
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const scored: Array<{ s: SymbolHit; score: number }> = [];
    for (const f of st.scan.files.values()) {
      for (const s of f.symbols) {
        const n = s.name.toLowerCase();
        let score = 0;
        if (n === q) score = 100;
        else if (n.startsWith(q)) score = 70;
        else if (n.includes(q)) score = 45;
        else continue;
        if (s.kind === 'module' && f.language === 'markdown') score -= 30;
        scored.push({ s, score: score - Math.min(10, n.length - q.length) / 2 });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path))
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map((x) => x.s);
  }

  async search(query: string, mode: SearchMode = 'hybrid', limit = 6, signal?: AbortSignal): Promise<SearchResult> {
    const st = await this.fresh(signal);
    this.setEmbedding(st, this.embedding);
    const lim = Math.max(1, Math.min(20, limit));
    const q = String(query ?? '').trim().slice(0, 2000);
    if (!q) return { hits: [], mode: 'lexical' };

    const lexical = mode === 'semantic' ? [] : bm25Search(st.scan.chunks, st.bm25, q, lim * 4);
    let semantic: Array<{ chunk: Chunk; score: number }> = [];
    if (mode !== 'lexical' && st.embed.setting && st.vectors.size > 0) {
      try {
        const [qv] = await embedTexts(st.embed.setting, [q.slice(0, 1800)], this.fetchImpl);
        for (const c of st.scan.chunks) {
          const v = st.vectors.get(vecKey(c));
          if (v) semantic.push({ chunk: c, score: dotProduct(qv, v) });
        }
        semantic.sort((a, b) => b.score - a.score);
        semantic = semantic.slice(0, lim * 4).filter((x) => x.score > 0.2);
      } catch {
        semantic = [];
      }
    }

    const usedSemantic = semantic.length > 0;
    const rankedIds =
      usedSemantic && lexical.length > 0
        ? fuseRanks([lexical.map((x) => x.chunk.id), semantic.map((x) => x.chunk.id)])
        : new Map((usedSemantic ? semantic : lexical).map((x, i) => [x.chunk.id, 1 / (60 + i + 1)]));
    const inLex = new Set(lexical.map((x) => x.chunk.id));
    const inSem = new Set(semantic.map((x) => x.chunk.id));
    const best = [...rankedIds.entries()].sort((a, b) => b[1] - a[1]);

    const perFile = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const [id, score] of best) {
      const c = st.scan.chunks[id];
      const n = perFile.get(c.path) ?? 0;
      if (n >= 1) continue;
      perFile.set(c.path, n + 1);
      hits.push({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        score: Number(score.toFixed(5)),
        via: inLex.has(id) && inSem.has(id) ? 'both' : inSem.has(id) ? 'semantic' : 'lexical',
      });
      if (hits.length >= lim) break;
    }
    return { hits, mode: usedSemantic ? (lexical.length > 0 ? 'hybrid' : 'semantic') : 'lexical' };
  }

  async repoMap(maxTokens = 800, focus: string[] = [], signal?: AbortSignal): Promise<RepoMapResult> {
    const st = await this.fresh(signal);
    const safeFocus = focus.filter((p) => typeof p === 'string' && !isDeniedPath(p)).slice(0, 20);
    return renderRepoMap(st.scan.files, Math.max(100, Math.min(4000, maxTokens)), safeFocus);
  }

  async git(_gitOp: GitOp): Promise<GitResult> {
    throw new WorkspaceError(
      'Git status and diff require the local Node server. @-mention files or symbols instead.',
      501
    );
  }
}

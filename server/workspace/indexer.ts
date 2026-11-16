import fs from 'node:fs';
import path from 'node:path';
import {
  IgnoreMatcher,
  LIMITS,
  bm25Search,
  buildBm25,
  buildFileChunks,
  extractImports,
  extractSymbols,
  fuseRanks,
  isBinaryName,
  isDeniedName,
  isDeniedPath,
  languageOf,
  looksBinaryBytes,
  queryTerms,
  rankFiles,
  redactSecrets,
  renderRepoMap,
  tokenize,
  type Bm25Index,
  type Chunk,
  type FileEntry,
  type ScanResult,
} from '../../src/lib/workspaceCore.ts';

export {
  LIMITS,
  bm25Search,
  buildBm25,
  fuseRanks,
  queryTerms,
  rankFiles,
  renderRepoMap,
  tokenize,
  type Bm25Index,
  type Chunk,
  type FileEntry,
  type ScanResult,
};

function readIgnoreForDir(dirAbs: string): IgnoreMatcher {
  const m = new IgnoreMatcher();
  for (const name of ['.gitignore', '.gemmaignore']) {
    try {
      const p = path.join(dirAbs, name);
      const lst = fs.lstatSync(p);
      if (!lst.isSymbolicLink() && lst.isFile() && lst.size < 200_000) {
        m.add(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      // no ignore file here
    }
  }
  return m;
}

/** Evaluates .gitignore / .gemmaignore rules from `rootReal` down through all ancestor folders of `rel`. */
export function isIgnoredPathOnDisk(
  rootReal: string,
  rel: string,
  isDir: boolean,
  cache = new Map<string, IgnoreMatcher>()
): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!norm) return false;
  if (isDeniedPath(norm) || (isDir && isDeniedName(norm.split('/').pop()!, true))) return true;
  const parts = norm.split('/');
  if (parts.length > LIMITS.maxDepth + 1) return true;

  const getMatcher = (relDir: string): IgnoreMatcher => {
    let m = cache.get(relDir);
    if (!m) {
      m = readIgnoreForDir(relDir ? path.join(rootReal, ...relDir.split('/')) : rootReal);
      cache.set(relDir, m);
    }
    return m;
  };

  for (let depth = 0; depth < parts.length; depth++) {
    const base = parts.slice(0, depth).join('/');
    const sub = parts.slice(depth).join('/');
    const m = getMatcher(base);
    if (m.ignores(sub, isDir)) return true;
  }
  return false;
}

function indexFileFromDisk(
  rootReal: string,
  rel: string,
  abs: string,
  st: fs.Stats,
  previous?: FileEntry
): { entry: FileEntry; chunks: Chunk[]; indexedBytes: number } {
  const language = languageOf(rel);
  const entry: FileEntry = {
    path: rel,
    size: st.size,
    mtimeMs: st.mtimeMs,
    language,
    indexed: false,
    lineCount: 0,
    imports: [],
    symbols: [],
  };

  if (isBinaryName(rel) || st.size > LIMITS.maxIndexBytes || st.size === 0) {
    return { entry, chunks: [], indexedBytes: 0 };
  }

  let content: string;
  try {
    const buf = fs.readFileSync(abs);
    if (looksBinaryBytes(buf)) return { entry, chunks: [], indexedBytes: 0 };
    content = buf.toString('utf8');
  } catch {
    return { entry, chunks: [], indexedBytes: 0 };
  }

  const fileKey = `${st.size}:${Math.floor(st.mtimeMs)}`;
  entry.indexed = true;
  entry.lineCount = content.split('\n').length;
  // Redact secrets before symbol extraction, import parsing, and chunking so secrets never surface in repo maps or search hits.
  const redacted = redactSecrets(content).text;
  if (previous && previous.indexed && `${previous.size}:${Math.floor(previous.mtimeMs)}` === fileKey) {
    entry.symbols = previous.symbols;
    entry.imports = previous.imports;
  } else {
    entry.symbols = extractSymbols(rel, language, redacted);
    entry.imports = extractImports(language, redacted);
  }
  const chunks = buildFileChunks(entry, fileKey, redacted);
  return { entry, chunks, indexedBytes: st.size };
}

export interface ScanOptions {
  /** Reuse results for files whose size and mtime are unchanged. */
  previous?: ScanResult;
}

export function scanWorkspace(rootReal: string, opts: ScanOptions = {}): ScanResult {
  const files = new Map<string, FileEntry>();
  const dirs = new Set<string>();
  const chunks: Chunk[] = [];
  let totalBytes = 0;
  let indexedBytes = 0;
  let truncated = false;

  const rootIgnore = readIgnoreForDir(rootReal);

  type Frame = { abs: string; rel: string; depth: number; ignores: Array<{ base: string; m: IgnoreMatcher }> };
  const stack: Frame[] = [{ abs: rootReal, rel: '', depth: 0, ignores: [{ base: '', m: rootIgnore }] }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(frame.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subDirs: Frame[] = [];
    for (const ent of entries) {
      // Symlinks are skipped entirely: they are the classic way to escape the project root.
      if (ent.isSymbolicLink()) continue;
      const isDir = ent.isDirectory();
      if (!isDir && !ent.isFile()) continue;
      if (isDeniedName(ent.name, isDir)) continue;
      const rel = frame.rel ? `${frame.rel}/${ent.name}` : ent.name;
      if (frame.ignores.some(({ base, m }) => m.ignores(base ? rel.slice(base.length + 1) : rel, isDir))) continue;

      if (isDir) {
        if (frame.depth + 1 > LIMITS.maxDepth) {
          truncated = true;
          continue;
        }
        dirs.add(rel);
        const abs = path.join(frame.abs, ent.name);
        const ignores = [...frame.ignores];
        ignores.push({ base: rel, m: readIgnoreForDir(abs) });
        subDirs.push({ abs, rel, depth: frame.depth + 1, ignores });
        continue;
      }

      if (files.size >= LIMITS.maxFiles) {
        truncated = true;
        continue;
      }
      const abs = path.join(frame.abs, ent.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      totalBytes += st.size;

      if (indexedBytes + st.size > LIMITS.maxTotalIndexBytes) {
        if (!isBinaryName(rel) && st.size <= LIMITS.maxIndexBytes && st.size > 0) truncated = true;
        files.set(rel, {
          path: rel,
          size: st.size,
          mtimeMs: st.mtimeMs,
          language: languageOf(rel),
          indexed: false,
          lineCount: 0,
          imports: [],
          symbols: [],
        });
        continue;
      }

      const indexed = indexFileFromDisk(rootReal, rel, abs, st, opts.previous?.files.get(rel));
      files.set(rel, indexed.entry);
      indexedBytes += indexed.indexedBytes;
      for (const c of indexed.chunks) chunks.push(c);
    }
    for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i]);
  }

  chunks.forEach((c, i) => (c.id = i));
  return { files, chunks, totalBytes, truncated, dirs };
}

/**
 * Incrementally applies changed, added, or deleted relative paths to an existing `ScanResult`
 * (used by the chokidar file watcher). Falls back to a full scan only if an ignore file changed.
 */
export function applyIncrementalChanges(
  rootReal: string,
  scan: ScanResult,
  dirtyRelPaths: Iterable<string>
): ScanResult {
  const dirty = new Set<string>();
  for (const raw of dirtyRelPaths) {
    const norm = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!norm || norm === '.' || norm.split('/').includes('..')) continue;
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    if (base === '.gitignore' || base === '.gemmaignore') {
      return scanWorkspace(rootReal, { previous: scan });
    }
    dirty.add(norm);
  }
  if (dirty.size === 0) return scan;

  const ignoreCache = new Map<string, IgnoreMatcher>();
  const touchedFiles = new Set<string>();
  const removedPrefixes: string[] = [];
  const addedOrUpdatedChunks = new Map<string, Chunk[]>();
  let truncated = scan.truncated;

  // Approximate current indexed bytes so incremental adds respect the workspace ceiling.
  let currentIndexedBytes = 0;
  for (const f of scan.files.values()) if (f.indexed) currentIndexedBytes += f.size;

  for (const rel of dirty) {
    const abs = path.join(rootReal, ...rel.split('/'));
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(abs);
    } catch {
      lst = null;
    }

    // Remove or skip missing paths, symlinks, paths escaping rootReal, denied names, and ignored paths.
    let validDir = false;
    let validFile = false;
    let realPath = '';
    if (lst && !lst.isSymbolicLink()) {
      try {
        realPath = fs.realpathSync(abs);
      } catch {
        realPath = '';
      }
      if (realPath && (realPath === rootReal || realPath.startsWith(rootReal + path.sep))) {
        if (lst.isDirectory()) {
          if (!isIgnoredPathOnDisk(rootReal, rel, true, ignoreCache)) validDir = true;
        } else if (lst.isFile()) {
          if (!isIgnoredPathOnDisk(rootReal, rel, false, ignoreCache)) validFile = true;
        }
      }
    }

    if (!validDir && !validFile) {
      if (scan.files.has(rel)) {
        const prev = scan.files.get(rel)!;
        if (prev.indexed) currentIndexedBytes -= prev.size;
        scan.files.delete(rel);
        touchedFiles.add(rel);
      }
      if (scan.dirs.has(rel)) {
        scan.dirs.delete(rel);
        removedPrefixes.push(`${rel}/`);
      } else if (!lst) {
        // An unlinked directory might already be absent from dirs or have files underneath it.
        const prefix = `${rel}/`;
        for (const fPath of scan.files.keys()) {
          if (fPath.startsWith(prefix)) {
            removedPrefixes.push(prefix);
            break;
          }
        }
      }
      continue;
    }

    if (validDir) {
      const depth = rel.split('/').length;
      if (depth <= LIMITS.maxDepth) scan.dirs.add(rel);
      else truncated = true;
      continue;
    }

    // validFile
    if (!scan.files.has(rel) && scan.files.size >= LIMITS.maxFiles) {
      truncated = true;
      continue;
    }
    const prev = scan.files.get(rel);
    if (prev?.indexed) currentIndexedBytes -= prev.size;
    touchedFiles.add(rel);

    const st = fs.statSync(realPath);
    if (currentIndexedBytes + st.size > LIMITS.maxTotalIndexBytes) {
      if (!isBinaryName(rel) && st.size <= LIMITS.maxIndexBytes && st.size > 0) truncated = true;
      scan.files.set(rel, {
        path: rel,
        size: st.size,
        mtimeMs: st.mtimeMs,
        language: languageOf(rel),
        indexed: false,
        lineCount: 0,
        imports: [],
        symbols: [],
      });
      continue;
    }

    const indexed = indexFileFromDisk(rootReal, rel, realPath, st, prev);
    scan.files.set(rel, indexed.entry);
    currentIndexedBytes += indexed.indexedBytes;
    if (indexed.chunks.length > 0) addedOrUpdatedChunks.set(rel, indexed.chunks);
  }

  if (removedPrefixes.length > 0) {
    for (const d of [...scan.dirs]) {
      if (removedPrefixes.some((p) => d.startsWith(p))) scan.dirs.delete(d);
    }
    for (const fPath of [...scan.files.keys()]) {
      if (removedPrefixes.some((p) => fPath.startsWith(p))) {
        scan.files.delete(fPath);
        touchedFiles.add(fPath);
      }
    }
  }

  const nextChunks: Chunk[] = [];
  for (const c of scan.chunks) {
    if (touchedFiles.has(c.path)) continue;
    if (removedPrefixes.some((p) => c.path.startsWith(p))) continue;
    nextChunks.push(c);
  }
  for (const list of addedOrUpdatedChunks.values()) {
    for (const c of list) nextChunks.push(c);
  }
  nextChunks.forEach((c, i) => (c.id = i));

  let totalBytes = 0;
  for (const f of scan.files.values()) totalBytes += f.size;

  return {
    files: scan.files,
    chunks: nextChunks,
    totalBytes,
    truncated,
    dirs: scan.dirs,
  };
}

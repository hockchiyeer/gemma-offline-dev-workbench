import fs from 'node:fs';
import path from 'node:path';
import type { SymbolHit } from '../../src/types/workspace.ts';
import { IgnoreMatcher } from './ignore.ts';
import { extractImports, extractSymbols } from './symbols.ts';
import { isBinaryName, isDeniedName, languageOf, looksBinary, redactSecrets } from './safety.ts';

export const LIMITS = {
  maxFiles: 6000,
  maxDepth: 14,
  maxIndexBytes: 400_000, // larger files are listed but not indexed
  maxReadBytes: 1_000_000,
  maxTotalIndexBytes: 60_000_000,
  chunkTargetLines: 40,
  chunkMaxLines: 70,
  chunkOverlap: 4,
};

export interface FileEntry {
  path: string; // forward-slash, relative to root
  size: number;
  mtimeMs: number;
  language: string;
  indexed: boolean;
  lineCount: number;
  imports: string[];
  symbols: SymbolHit[];
}

export interface Chunk {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Hash of file mtime+size, so vectors can be reused while a file is unchanged. */
  fileKey: string;
  tf: Map<string, number>;
  len: number;
}

export interface ScanResult {
  files: Map<string, FileEntry>;
  chunks: Chunk[];
  totalBytes: number;
  truncated: boolean;
  dirs: Set<string>;
}

/** Splits identifiers and paths into lowercase search terms (camelCase, snake_case, kebab-case). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && lower.length <= 40) out.push(lower);
    const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/);
    if (parts.length > 1) for (const p of parts) if (p.length >= 2) out.push(p.toLowerCase());
  }
  return out;
}

function addChunk(chunks: Chunk[], file: FileEntry, fileKey: string, lines: string[], start: number, end: number) {
  const text = lines.slice(start, end).join('\n');
  if (!text.trim()) return;
  const tf = new Map<string, number>();
  const terms = tokenize(text);
  // File path terms make "payments" find payments.ts even when the body rarely repeats the word.
  for (const t of tokenize(file.path)) terms.push(t, t);
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  chunks.push({ id: chunks.length, path: file.path, startLine: start + 1, endLine: end, text, fileKey, tf, len: terms.length });
}

function chunkFile(chunks: Chunk[], file: FileEntry, fileKey: string, content: string) {
  const lines = content.split('\n');
  const symbolLines = new Set(file.symbols.map((s) => s.line - 1));
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + LIMITS.chunkTargetLines);
    // Prefer to end just before the next symbol so a chunk holds whole functions where possible.
    if (end < lines.length) {
      const limit = Math.min(lines.length, start + LIMITS.chunkMaxLines);
      for (let i = end; i < limit; i++) {
        if (symbolLines.has(i)) {
          end = i;
          break;
        }
      }
      for (let i = end; i > start + 12; i--) {
        if (symbolLines.has(i)) {
          end = i;
          break;
        }
      }
    }
    addChunk(chunks, file, fileKey, lines, start, end);
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - LIMITS.chunkOverlap);
  }
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

  const rootIgnore = new IgnoreMatcher();
  const readIgnore = (dirAbs: string, m: IgnoreMatcher) => {
    for (const name of ['.gitignore', '.gemmaignore']) {
      try {
        const st = fs.statSync(path.join(dirAbs, name));
        if (st.isFile() && st.size < 200_000) m.add(fs.readFileSync(path.join(dirAbs, name), 'utf8'));
      } catch {
        // no ignore file here
      }
    }
  };
  readIgnore(rootReal, rootIgnore);

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
        const local = new IgnoreMatcher();
        readIgnore(abs, local);
        ignores.push({ base: rel, m: local });
        subDirs.push({ abs, rel, depth: frame.depth + 1, ignores });
        continue;
      }

      if (files.size >= LIMITS.maxFiles) {
        truncated = true;
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(frame.abs, ent.name));
      } catch {
        continue;
      }
      totalBytes += st.size;
      const language = languageOf(rel);
      const entry: FileEntry = {
        path: rel, size: st.size, mtimeMs: st.mtimeMs, language,
        indexed: false, lineCount: 0, imports: [], symbols: [],
      };
      files.set(rel, entry);

      if (isBinaryName(rel) || st.size > LIMITS.maxIndexBytes || st.size === 0) continue;
      if (indexedBytes + st.size > LIMITS.maxTotalIndexBytes) {
        truncated = true;
        continue;
      }
      const fileKey = `${st.size}:${Math.floor(st.mtimeMs)}`;
      const prev = opts.previous?.files.get(rel);
      let content: string;
      try {
        const buf = fs.readFileSync(path.join(frame.abs, ent.name));
        if (looksBinary(buf)) continue;
        content = buf.toString('utf8');
      } catch {
        continue;
      }
      indexedBytes += st.size;
      entry.indexed = true;
      entry.lineCount = content.split('\n').length;
      // Redact secrets before symbol extraction, import parsing, and chunking so secrets never surface in repo maps or search hits.
      const redacted = redactSecrets(content).text;
      if (prev && prev.indexed && `${prev.size}:${Math.floor(prev.mtimeMs)}` === fileKey) {
        entry.symbols = prev.symbols;
        entry.imports = prev.imports;
      } else {
        entry.symbols = extractSymbols(rel, language, redacted);
        entry.imports = extractImports(language, redacted);
      }
      chunkFile(chunks, entry, fileKey, redacted);
    }
    for (let i = subDirs.length - 1; i >= 0; i--) stack.push(subDirs[i]);
  }

  chunks.forEach((c, i) => (c.id = i));
  return { files, chunks, totalBytes, truncated, dirs };
}

// ---- BM25 -----------------------------------------------------------------------------------

export interface Bm25Index {
  df: Map<string, number>;
  avgLen: number;
  n: number;
}

export function buildBm25(chunks: Chunk[]): Bm25Index {
  const df = new Map<string, number>();
  let total = 0;
  for (const c of chunks) {
    total += c.len;
    for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { df, avgLen: chunks.length ? total / chunks.length : 1, n: chunks.length };
}

const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'why', 'does', 'this', 'that', 'with', 'from', 'are', 'is', 'in', 'of', 'to', 'a', 'it', 'on', 'do', 'be', 'can', 'my', 'me', 'we', 'you', 'about', 'please', 'explain', 'show', 'tell']);

export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenize(query)) if (!STOP.has(t)) seen.add(t);
  return [...seen];
}

export function bm25Search(chunks: Chunk[], idx: Bm25Index, query: string, limit: number): Array<{ chunk: Chunk; score: number }> {
  const terms = queryTerms(query);
  if (terms.length === 0 || idx.n === 0) return [];
  const k1 = 1.4;
  const b = 0.75;
  const scored: Array<{ chunk: Chunk; score: number }> = [];
  for (const chunk of chunks) {
    let score = 0;
    for (const t of terms) {
      const f = chunk.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (idx.n - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * chunk.len) / idx.avgLen));
    }
    if (score > 0) scored.push({ chunk, score });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, limit);
}

/** Reciprocal rank fusion of several ranked lists of chunk ids. */
export function fuseRanks(lists: number[][], k = 60): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of lists) list.forEach((id, rank) => out.set(id, (out.get(id) ?? 0) + 1 / (k + rank + 1)));
  return out;
}

// ---- repo map --------------------------------------------------------------------------------

function importTarget(from: string, spec: string, files: Map<string, FileEntry>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.py`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/__init__.py`];
  for (const c of candidates) if (files.has(c)) return c;
  // TypeScript sources imported as "./x.ts" or "./x.js"
  const stripped = base.replace(/\.(js|mjs)$/, '');
  for (const ext of ['.ts', '.tsx']) if (files.has(stripped + ext)) return stripped + ext;
  return null;
}

export function rankFiles(files: Map<string, FileEntry>, focus: string[] = []): FileEntry[] {
  const inbound = new Map<string, number>();
  for (const f of files.values()) {
    for (const spec of f.imports) {
      const target = importTarget(f.path, spec, files);
      if (target && target !== f.path) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }
  const newest = Math.max(1, ...[...files.values()].map((f) => f.mtimeMs));
  const oldest = Math.min(newest, ...[...files.values()].map((f) => f.mtimeMs));
  const span = Math.max(1, newest - oldest);
  const focusSet = new Set(focus);
  const score = (f: FileEntry) => {
    let s = Math.log2(1 + (inbound.get(f.path) ?? 0)) * 2;
    s += ((f.mtimeMs - oldest) / span) * 1.5;
    if (focusSet.has(f.path)) s += 10;
    else if (focus.some((p) => path.posix.dirname(p) === path.posix.dirname(f.path))) s += 1.5;
    if (/(^|\/)(index|main|app|server)\.[a-z]+$/.test(f.path)) s += 1;
    if (/(^|\/)(tests?|__tests__|spec)\//.test(f.path) || /\.(test|spec)\./.test(f.path)) s -= 1.5;
    return s;
  };
  return [...files.values()].filter((f) => f.indexed && f.symbols.length > 0).sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
}

export function renderRepoMap(files: Map<string, FileEntry>, maxTokens: number, focus: string[] = []): { text: string; files: number; symbols: number } {
  const maxChars = Math.max(400, Math.floor(maxTokens * 3.2));
  const ranked = rankFiles(files, focus);
  const out: string[] = [];
  let used = 0;
  let nFiles = 0;
  let nSyms = 0;
  for (const f of ranked) {
    const top = f.symbols.filter((s) => s.kind !== 'method' || f.language !== 'typescript').slice(0, 12);
    const block = [f.path, ...top.map((s) => `  ${s.signature.slice(0, 100)}`)].join('\n');
    if (used + block.length + 1 > maxChars) {
      if (nFiles === 0) continue;
      break;
    }
    out.push(block);
    used += block.length + 1;
    nFiles++;
    nSyms += top.length;
  }
  const remaining = ranked.length - nFiles;
  if (remaining > 0) out.push(`… plus ${remaining} more source files not shown`);
  return { text: out.join('\n'), files: nFiles, symbols: nSyms };
}

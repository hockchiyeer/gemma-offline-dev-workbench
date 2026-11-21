import type { EmbeddingSetting, SymbolHit, SymbolKind } from '../types/workspace.ts';

export class WorkspaceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

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

/** Directories that are never indexed, listed or read (secrets, VCS internals, dependencies, build output). */
export const DENIED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.gemmavault', '.ssh', '.gnupg', '.aws', '.azure', '.kube',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'target', '.gradle', '.idea', '.vscode',
]);

const DENIED_FILE_RES: RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|crt|cer|der|ppk|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // id_rsa, id_rsa.pub, id_rsa_backup, id_ed25519-work ...
  /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd|pgpass|my\.cnf|dockercfg|s3cfg|boto)$/i,
  /^(credentials|secrets?)(\.[a-z]+)?$/i,
  /^(credentials|secrets?)(\.[a-z0-9_-]+)*\.(json|ya?ml|toml|ini|env|conf|cfg|properties|xml|txt|bak|backup|old)$/i,
  /^(known_hosts|authorized_keys)$/i,
  /^kubeconfig(\..+)?$/i,
  /^service[-_]?account.*\.json$/i,
  /^client[-_]?secrets?.*\.json$/i,
  /\.(tfstate|tfvars)(\.backup)?$/i,
  /\.(sqlite3?|db)$/i,
  /\.gvbackup$/i,
];
// Template files are meant to be shared and contain no real values.
const ALLOWED_ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'avif', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm', 'pyc',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'ogg', 'flac', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'lock', 'map',
]);

export function isDeniedName(name: string, isDir: boolean): boolean {
  if (isDir) return DENIED_DIRS.has(name);
  if (ALLOWED_ENV_TEMPLATE.test(name)) return false;
  return DENIED_FILE_RES.some((re) => re.test(name));
}

/** True if any segment of a relative path is denied. */
export function isDeniedPath(rel: string): boolean {
  const parts = rel.split('/').filter(Boolean);
  return parts.some((p, i) => isDeniedName(p, i < parts.length - 1));
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', html: 'html', htm: 'html',
  css: 'css', scss: 'css', md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', txt: 'text',
};

function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function languageOf(relPath: string): string {
  const ext = extOf(relPath);
  return EXT_LANG[ext] ?? (ext || 'text');
}

export function isBinaryName(relPath: string): boolean {
  return BINARY_EXTENSIONS.has(extOf(relPath));
}

export function looksBinaryBytes(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ---- secret redaction ---------------------------------------------------------------------------

const REDACT_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /((?:api[_-]?key|secret|token|passwd|password|private[_-]?key)["']?\s*[:=]\s*["'])[^"'\n]{8,}(["'])/gi,
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of REDACT_RES) {
    out = out.replace(re, (...m: unknown[]) => {
      count++;
      const g1 = typeof m[1] === 'string' && re.source.startsWith('((?:api') ? (m[1] as string) : '';
      const g2 = g1 ? (m[2] as string) : '';
      return `${g1}[REDACTED]${g2}`;
    });
  }
  return { text: out, count };
}

// ---- .gitignore / .gemmaignore matcher ----------------------------------------------------------

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string, anchored: boolean): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      } else {
        out += '\\[';
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 1;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}$`);
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  add(text: string): this {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      }
      let dirOnly = false;
      if (line.endsWith('/')) {
        dirOnly = true;
        line = line.slice(0, -1);
      }
      if (!line) continue;
      const anchored = line.startsWith('/') || line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      this.rules.push({ re: globToRegex(line, anchored), negate, dirOnly });
    }
    return this;
  }

  /** `rel` is a forward-slash path relative to the directory the .gitignore lives in. */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.test(parts.slice(0, i).join('/'), true)) return true;
    }
    if (this.test(rel, isDir)) ignored = true;
    return ignored;
  }

  private test(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
    return ignored;
  }
}

// ---- multi-language regex symbol & import extraction --------------------------------------------

interface Pattern {
  re: RegExp;
  kind: SymbolKind;
  name: number;
}

const TS: Pattern[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', name: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type', name: 1 },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', name: 1 },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function', name: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, kind: 'const', name: 1 },
];
const PY: Pattern[] = [
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
];
const GO: Pattern[] = [
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct', name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface', name: 1 },
];
const RUST: Pattern[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', name: 1 },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>]*\s+for\s+)?([A-Za-z_]\w*)/, kind: 'module', name: 1 },
];
const JAVAISH: Pattern[] = [
  { re: /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|partial|data)\s+)*(?:class|record|object)\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_]\w*)/, kind: 'interface', name: 1 },
  { re: /^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+([A-Za-z_]\w*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|async|virtual|suspend)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\([^;]*$/, kind: 'method', name: 1 },
  { re: /^\s*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, kind: 'function', name: 1 },
];
const SQL: Pattern[] = [
  { re: /^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, kind: 'module', name: 1 },
];
const MD: Pattern[] = [{ re: /^#{1,3}\s+(.+?)\s*#*$/, kind: 'module', name: 1 }];
const SH: Pattern[] = [{ re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: 'function', name: 1 }];

const BY_LANG: Record<string, Pattern[]> = {
  typescript: TS, javascript: TS, python: PY, go: GO, rust: RUST,
  java: JAVAISH, kotlin: JAVAISH, csharp: JAVAISH, cpp: JAVAISH.slice(0, 3),
  sql: SQL, markdown: MD, bash: SH,
};

const KEYWORD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'function', 'constructor']);

export function extractSymbols(relPath: string, language: string, content: string): SymbolHit[] {
  const patterns = BY_LANG[language];
  if (!patterns) return [];
  const out: SymbolHit[] = [];
  const lines = content.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const line = lines[i];
    if (language === 'markdown' && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || line.length > 400) continue;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      const name = m[p.name]?.trim();
      if (!name || KEYWORD_NAMES.has(name)) continue;
      out.push({
        name,
        kind: p.kind,
        path: relPath,
        line: i + 1,
        signature: line.trim().replace(/\s*\{\s*$/, '').slice(0, 140),
      });
      break;
    }
  }
  return out;
}

export function extractImports(language: string, content: string): string[] {
  const specs = new Set<string>();
  if (language === 'typescript' || language === 'javascript') {
    for (const m of content.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) specs.add(m[1]);
  } else if (language === 'python') {
    for (const m of content.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm)) specs.add(m[1] || m[2]);
  } else if (language === 'go' || language === 'java' || language === 'kotlin' || language === 'rust') {
    for (const m of content.matchAll(/(?:import|use)\s+"?([\w./:]+)"?/g)) specs.add(m[1]);
  }
  return [...specs].slice(0, 80);
}

// ---- chunking, BM25 & repo map ------------------------------------------------------------------

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
  /** Lowercased names of the symbols declared inside this chunk (used to favour definitions over usages). */
  defs?: string[];
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
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/);
    if (parts.length > 1) for (const p of parts) if (p.length >= 2) out.push(p.toLowerCase());
  }
  return out;
}

function makeChunk(file: FileEntry, fileKey: string, lines: string[], start: number, end: number): Chunk | null {
  const text = lines.slice(start, end).join('\n');
  if (!text.trim()) return null;
  const tf = new Map<string, number>();
  const terms = tokenize(text);
  for (const t of tokenize(file.path)) terms.push(t, t);
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { id: 0, path: file.path, startLine: start + 1, endLine: end, text, fileKey, tf, len: terms.length };
}

export function buildFileChunks(file: FileEntry, fileKey: string, content: string): Chunk[] {
  const out: Chunk[] = [];
  const lines = content.split('\n');
  const symbolLines = new Set(file.symbols.map((s) => s.line - 1));
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + LIMITS.chunkTargetLines);
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
    const c = makeChunk(file, fileKey, lines, start, end);
    if (c) {
      c.defs = file.symbols.filter((s) => s.line - 1 >= start && s.line - 1 < end).map((s) => s.name.toLowerCase());
      out.push(c);
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - LIMITS.chunkOverlap);
  }
  return out;
}

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

const STOP = new Set([
  'the', 'and', 'for', 'how', 'what', 'why', 'does', 'this', 'that', 'with', 'from', 'are', 'is',
  'in', 'of', 'to', 'a', 'it', 'on', 'do', 'be', 'can', 'my', 'me', 'we', 'you', 'about', 'please',
  'explain', 'show', 'tell',
]);

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
  adjustForIntent(scored, query, terms);
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, limit);
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i;
const DOC_PATH_RE = /\.(md|mdx|txt)$/i;
const DOC_WORDS = new Set(['readme', 'doc', 'docs', 'documentation', 'guide', 'markdown', 'changelog']);

export const isTestPath = (p: string): boolean => TEST_PATH_RE.test(p);

/** camelCase / snake_case name -> lowercase parts ("buildGemmaMessages" -> build, gemma, messages). */
function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

/**
 * Re-weights BM25 scores for what the question is probably after, in place:
 *  - a chunk that DECLARES a symbol the question names outranks chunks that merely use it;
 *  - tests and documentation rank below the implementation unless the question is about them.
 * Without this, short test files and READMEs (dense with the question's words) beat the real code.
 */
function adjustForIntent(scored: Array<{ chunk: Chunk; score: number }>, query: string, terms: string[]): void {
  if (scored.length === 0) return;
  const top = scored.reduce((m, s) => Math.max(m, s.score), 0);
  // Lowercased query words -> whether the user typed them like an identifier (retryFailedPayment, snake_case).
  const words = new Map<string, boolean>();
  for (const w of query.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (w.length < 3) continue;
    const identifierShaped = /[a-z][A-Z]/.test(w) || w.includes('_');
    words.set(w.toLowerCase(), (words.get(w.toLowerCase()) ?? false) || identifierShaped);
  }
  const termSet = new Set(terms);
  const testIntent = terms.some((t) => t.startsWith('test') || t === 'spec');
  const docIntent = terms.some((t) => DOC_WORDS.has(t));
  for (const s of scored) {
    if (s.chunk.defs?.length) {
      let boost = 0;
      for (const d of s.chunk.defs) {
        if (words.has(d)) {
          // A deliberately typed identifier wins outright; an everyday word that merely equals a symbol
          // name ("render", "name") gets a modest nudge, or common words would over-promote definitions.
          boost = Math.max(boost, words.get(d) ? 1 : 0.6);
          if (words.get(d)) break;
          continue;
        }
        const parts = nameParts(d);
        if (parts.length >= 2 && parts.every((p) => termSet.has(p))) boost = Math.max(boost, 0.25);
      }
      s.score += top * boost;
    }
    if (!testIntent && isTestPath(s.chunk.path)) s.score *= 0.65;
    if (!docIntent && DOC_PATH_RE.test(s.chunk.path)) s.score *= 0.85;
  }
}

/** Reciprocal rank fusion of several ranked lists of chunk ids. */
export function fuseRanks(lists: number[][], k = 60): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of lists) list.forEach((id, rank) => out.set(id, (out.get(id) ?? 0) + 1 / (k + rank + 1)));
  return out;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i);
}

function posixNormalizeJoin(dir: string, rel: string): string {
  const combined = dir === '.' ? rel : `${dir}/${rel}`;
  const out: string[] = [];
  for (const seg of combined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function importTarget(from: string, spec: string, files: Map<string, FileEntry>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posixNormalizeJoin(posixDirname(from), spec);
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.py`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/__init__.py`,
  ];
  for (const c of candidates) if (files.has(c)) return c;
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
    else if (focus.some((p) => posixDirname(p) === posixDirname(f.path))) s += 1.5;
    if (/(^|\/)(index|main|app|server)\.[a-z]+$/.test(f.path)) s += 1;
    if (/(^|\/)(tests?|__tests__|spec)\//.test(f.path) || /\.(test|spec)\./.test(f.path)) s -= 1.5;
    return s;
  };
  return [...files.values()]
    .filter((f) => f.indexed && f.symbols.length > 0)
    .sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
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

/** Subsequence-aware path scoring for @-mention autocomplete. Higher is better; 0 = no match. */
export function scorePath(rel: string, query: string): number {
  const q = query.toLowerCase();
  const p = rel.toLowerCase();
  if (!q) return 1;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === q) return 100;
  if (base.startsWith(q)) return 80 - Math.min(20, base.length - q.length);
  if (base.includes(q)) return 60 - Math.min(20, base.length - q.length);
  if (p.includes(q)) return 40 - Math.min(20, p.length / 10);
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] === q[qi]) {
      if (last >= 0 && i - last > 1) gaps++;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? Math.max(1, 25 - gaps * 3) : 0;
}

// ---- embedding & vector helpers -----------------------------------------------------------------

export const vecKey = (c: Pick<Chunk, 'path' | 'startLine' | 'fileKey'>) => `${c.path}:${c.startLine}:${c.fileKey}`;

export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeVector(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export async function embedTexts(
  setting: EmbeddingSetting,
  input: string[],
  fetchImpl: typeof fetch = fetch
): Promise<Float32Array[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetchImpl(new URL('/api/embed', setting.baseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: setting.model, input }),
      signal: ctl.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      throw new Error(
        `Embedding model returned HTTP ${res.status}. Is "${setting.model}" installed (ollama pull ${setting.model})?`
      );
    }
    const json = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== input.length) {
      throw new Error('Embedding model returned an unexpected response.');
    }
    return json.embeddings.map(normalizeVector);
  } finally {
    clearTimeout(timer);
  }
}

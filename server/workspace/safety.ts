import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class WorkspaceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Directories that are never indexed, listed or read (secrets, VCS internals, dependencies, build output). */
export const DENIED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.gemmavault', '.ssh', '.gnupg', '.aws', '.azure', '.kube',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'target', '.gradle', '.idea', '.vscode',
]);

const DENIED_FILE_RES: RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|crt|cer|der)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i,
  /^(credentials|secrets?)(\.[a-z]+)?$/i,
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

export function languageOf(relPath: string): string {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return EXT_LANG[ext] ?? (ext || 'text');
}

export function isBinaryName(relPath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(relPath).slice(1).toLowerCase());
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Resolves `rel` inside `rootReal` (already a realpath). Blocks absolute paths, "..", NUL bytes and
 * symlinks that point outside the root, and refuses denied names. Returns the real absolute path.
 */
export function resolveInside(rootReal: string, rel: string): string {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new WorkspaceError('Invalid path.');
  const norm = rel.replace(/\\/g, '/');
  if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new WorkspaceError('Paths must be relative to the project folder.');
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new WorkspaceError('Path escapes the project folder.', 403);
  const joined = path.join(rootReal, ...parts);
  let real: string;
  try {
    real = fs.realpathSync(joined);
  } catch {
    throw new WorkspaceError('File not found.', 404);
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new WorkspaceError('Path escapes the project folder.', 403);
  }
  const relReal = path.relative(rootReal, real).split(path.sep).join('/');
  if (isDeniedPath(relReal) || isDeniedPath(parts.join('/'))) {
    throw new WorkspaceError('That file is excluded from project context (secrets, build output or VCS data).', 403);
  }
  return real;
}

/** Validates and canonicalises a folder the user wants to open. */
export function resolveRoot(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) throw new WorkspaceError('Enter a folder path.');
  let p = rawPath.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new WorkspaceError('Use an absolute folder path (for example /home/me/project or C:\\code\\project).');
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    throw new WorkspaceError('That folder does not exist.', 404);
  }
  if (!fs.statSync(real).isDirectory()) throw new WorkspaceError('That path is a file, not a folder.');
  if (path.parse(real).root === real) throw new WorkspaceError('Pick a project folder, not a drive or filesystem root.');
  if (real === os.homedir()) throw new WorkspaceError('Pick a project folder inside your home directory, not the home directory itself.');
  return real;
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

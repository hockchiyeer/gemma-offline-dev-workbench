import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BINARY_EXTENSIONS,
  DENIED_DIRS,
  WorkspaceError,
  isBinaryName,
  isDeniedName,
  isDeniedPath,
  languageOf,
  looksBinaryBytes,
  redactSecrets,
} from '../../src/lib/workspaceCore.ts';

export {
  BINARY_EXTENSIONS,
  DENIED_DIRS,
  WorkspaceError,
  isBinaryName,
  isDeniedName,
  isDeniedPath,
  languageOf,
  redactSecrets,
};

export function looksBinary(buf: Buffer): boolean {
  return looksBinaryBytes(buf);
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
  if (!isInsideDir(rootReal, real)) {
    throw new WorkspaceError('Path escapes the project folder.', 403);
  }
  const relReal = path.relative(rootReal, real).split(path.sep).join('/');
  if (isDeniedPath(relReal) || isDeniedPath(parts.join('/'))) {
    throw new WorkspaceError('That file is excluded from project context (secrets, build output or VCS data).', 403);
  }
  return real;
}

/** Validates and canonicalises a folder the user wants to open. */
const POSIX_SYSTEM_DIRS = [
  '/etc', '/proc', '/sys', '/dev', '/boot', '/run', '/sbin', '/bin', '/lib', '/lib32', '/lib64',
  '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/libexec', '/var/log', '/var/lib',
  '/system', '/library', '/private/etc', '/private/var/db',
];
const WINDOWS_SYSTEM_RE = /^[a-z]:\/(windows|program files( \(x86\))?|programdata)(\/|$)/;
const CREDENTIAL_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.azure']);

/** True for operating-system folders, which are never a "project" (compared case-insensitively). */
export function isSystemFolder(real: string): boolean {
  const norm = real.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return WINDOWS_SYSTEM_RE.test(`${norm}/`) || POSIX_SYSTEM_DIRS.some((d) => norm === d || norm.startsWith(`${d}/`));
}

export function isInsideDir(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  const norm = (p: string) => {
    const unified = platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
    return unified.length > 1 && unified.endsWith(sep) ? unified.replace(/[\\/]+$/, '') : unified;
  };
  const r = norm(root);
  const c = norm(candidate);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`;
  return c.startsWith(prefix);
}

/** Operator-configured roots (GEMMAVAULT_WORKSPACE_ROOTS, path-delimiter separated); empty means "any folder". */
export function configuredRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.GEMMAVAULT_WORKSPACE_ROOTS ?? '')
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean);
}

export function resolveRoot(rawPath: string, opts: { allowedRoots?: string[] } = {}): string {
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
  let homeReal = os.homedir();
  try {
    homeReal = fs.realpathSync(homeReal);
  } catch {
    // Keep os.homedir() if realpath fails.
  }
  const isHome = process.platform === 'win32' ? real.toLowerCase() === homeReal.toLowerCase() : real === homeReal;
  if (isHome) throw new WorkspaceError('Pick a project folder inside your home directory, not the home directory itself.');
  if (isSystemFolder(real)) throw new WorkspaceError('That is an operating-system folder. Pick a project folder.', 403);
  if (real.split(/[\\/]/).some((seg) => CREDENTIAL_DIRS.has(seg.toLowerCase()))) {
    throw new WorkspaceError('That folder holds credentials (for example .ssh or .aws) and cannot be opened.', 403);
  }
  const allowed = opts.allowedRoots ?? configuredRoots();
  if (allowed.length > 0) {
    const ok = allowed.some((r) => {
      try {
        return isInsideDir(fs.realpathSync(path.resolve(r)), real);
      } catch {
        return false;
      }
    });
    if (!ok) throw new WorkspaceError('That folder is outside the roots this server may open (GEMMAVAULT_WORKSPACE_ROOTS).', 403);
  }
  return real;
}

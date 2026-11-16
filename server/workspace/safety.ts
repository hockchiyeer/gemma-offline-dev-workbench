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

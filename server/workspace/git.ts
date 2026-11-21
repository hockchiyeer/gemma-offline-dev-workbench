/**
 * Pure helpers for the workspace git operations: locating the repository, and turning raw git output
 * into something safe to show a model (denied paths removed). Kept free of process spawning so it can
 * be tested directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeniedPath } from '../../src/lib/workspaceCore.ts';

/**
 * The nearest folder at or above `start` that contains `.git` (a directory, or a file for worktrees and
 * submodules). A repository rooted at the user's home directory or the filesystem root is ignored: it is
 * almost always a dotfiles repo, and treating every project under it as "a git project" would be wrong.
 */
export function findGitRoot(start: string): string | null {
  let home: string | null = null;
  try {
    const rawHome = path.resolve(os.homedir());
    try {
      home = fs.realpathSync(rawHome);
    } catch {
      home = rawHome;
    }
  } catch {
    home = null;
  }
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      if (dir === home || path.parse(dir).root === dir) return null;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Folder of `workspaceRoot` relative to the repository top, as a posix prefix ("" at the top, else "a/b/"). */
export function repoPrefix(gitRoot: string, workspaceRoot: string): string {
  const rel = path.relative(gitRoot, workspaceRoot).split(path.sep).join('/');
  return rel ? `${rel}/` : '';
}

export interface StatusEntry {
  /** Two-character porcelain code, e.g. " M", "??", "R ". */
  code: string;
  /** Path relative to the repository top. */
  path: string;
  /** For renames/copies: the original path. */
  orig?: string;
}

/** Parses `git status --porcelain=v1 -z --branch`. */
export function parseStatusZ(raw: string): { branch?: string; entries: StatusEntry[] } {
  const parts = raw.split('\0');
  let branch: string | undefined;
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      branch = p.slice(3);
      continue;
    }
    const code = p.slice(0, 2);
    const file = p.slice(3);
    if (!file) continue;
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') {
      entries.push({ code, path: file, orig: parts[++i] });
    } else {
      entries.push({ code, path: file });
    }
  }
  return { branch, entries };
}

const relativeTo = (repoPath: string, prefix: string) => (prefix && repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath);

/**
 * `git status --short --branch` style text, relative to the workspace folder, without entries for
 * denied paths (so file NAMES like `.env` or `deploy.pem` are not revealed either).
 */
export function formatStatus(parsed: { branch?: string; entries: StatusEntry[] }, prefix: string): { text: string; hidden: number } {
  const lines: string[] = [];
  let hidden = 0;
  if (parsed.branch) lines.push(`## ${parsed.branch}`);
  for (const e of parsed.entries) {
    const rel = relativeTo(e.path, prefix);
    const orig = e.orig ? relativeTo(e.orig, prefix) : undefined;
    if (
      isDeniedPath(rel) ||
      isDeniedPath(e.path) ||
      (orig !== undefined && (isDeniedPath(orig) || isDeniedPath(e.orig!)))
    ) {
      hidden++;
      continue;
    }
    lines.push(`${e.code} ${orig ? `${orig} -> ` : ''}${rel}`);
  }
  return { text: lines.join('\n'), hidden };
}

/**
 * Removes whole per-file sections of a unified diff whose path is denied. Fails closed: a section whose
 * header cannot be parsed (for example a quoted path with unusual characters) is dropped too.
 */
export function filterDiffByDenied(diff: string, prefix = ''): { diff: string; dropped: number } {
  const sections = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  let dropped = 0;
  for (const section of sections) {
    if (!section.startsWith('diff --git ')) {
      if (section.trim()) kept.push(section);
      continue;
    }
    const m = section.split('\n', 1)[0].match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!m || [m[1], m[2]].some((p) => isDeniedPath(p) || isDeniedPath(relativeTo(p, prefix)))) {
      dropped++;
      continue;
    }
    kept.push(section);
  }
  return { diff: kept.join(''), dropped };
}

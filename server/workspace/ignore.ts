/**
 * Small .gitignore matcher (no dependencies). Supports comments, negation (!), directory-only
 * patterns (trailing /), anchored patterns (leading / or an inner /), *, ?, ** and character classes.
 * Good enough to keep build output and vendored code out of an index; it is not a Git replacement.
 */

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
        // "**/" matches zero or more directories; a trailing "**" matches everything below.
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
    // A parent directory that is ignored hides everything below it.
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

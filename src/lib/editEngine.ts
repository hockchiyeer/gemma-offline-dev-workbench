/**
 * Edit engine for AI-proposed code changes.
 *
 * Small local models are unreliable at line-numbered unified diffs but good at quoting a few lines and
 * rewriting them, so edits are exchanged as SEARCH/REPLACE blocks:
 *
 *   <snippet title>
 *   <<<<<<< SEARCH
 *   exact existing lines
 *   =======
 *   replacement lines
 *   >>>>>>> REPLACE
 *
 * Everything here is pure text-in / text-out (no DOM, no storage) so the same pipeline can later target
 * workspace files as well as vault snippets:
 *   parseEditBlocks -> planHunks (layered matching) -> applyHunks (selective, overlap-safe) -> diffLines
 * plus a heuristic syntax check used to warn when an edit makes a file look worse than it was.
 */
import type { EditHunk, SupportedLanguage } from '../types/vault';

// ---------------------------------------------------------------------------------------------
// Hashing (stale-edit detection; not a security primitive)
// ---------------------------------------------------------------------------------------------

/** 53-bit string hash (cyrb53). Used to detect that a file changed between preview and apply. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const SEARCH_RE = /^\s*<{5,}\s*SEARCH\s*$/i;
const DIVIDER_RE = /^\s*={5,}\s*$/;
const REPLACE_RE = /^\s*>{5,}\s*REPLACE\s*$/i;
const FENCE_ONLY_RE = /^\s*(`{3,}|~{3,})[\w+-]*\s*$/;

export interface ParsedEditBlock {
  /** What the model called the file (usually the snippet title), if it said. */
  target?: string;
  search: string;
  replace: string;
  /** 1-based line of the SEARCH marker in the reply, for error messages. */
  line: number;
}

export interface ParseResult {
  blocks: ParsedEditBlock[];
  errors: string[];
}

function cleanLabel(raw: string): string | undefined {
  const unwrap = (t: string) =>
    t.trim().replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').replace(/^\*{1,2}|\*{1,2}$/g, '').replace(/^`+|`+$/g, '').replace(/:$/, '').trim();
  let s = unwrap(raw);
  s = unwrap(s.replace(/^(file|snippet|path|target)\s*:\s*/i, ''));
  if (!s || s.length > 160) return undefined;
  if (SEARCH_RE.test(s) || DIVIDER_RE.test(s) || REPLACE_RE.test(s)) return undefined;
  return s;
}

function findTargetLabel(lines: string[], searchIdx: number): string | undefined {
  let j = searchIdx - 1;
  while (j >= 0 && lines[j].trim() === '') j--;
  if (j >= 0 && FENCE_ONLY_RE.test(lines[j])) {
    j--;
    while (j >= 0 && lines[j].trim() === '') j--;
  }
  if (j < 0) return undefined;
  if (REPLACE_RE.test(lines[j]) || FENCE_ONLY_RE.test(lines[j])) return undefined;
  return cleanLabel(lines[j]);
}

export function parseEditBlocks(text: string): ParseResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedEditBlock[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!SEARCH_RE.test(lines[i])) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const target = findTargetLabel(lines, i);

    const search: string[] = [];
    let j = i + 1;
    let divider = -1;
    for (; j < lines.length; j++) {
      if (DIVIDER_RE.test(lines[j])) {
        divider = j;
        break;
      }
      if (REPLACE_RE.test(lines[j]) || SEARCH_RE.test(lines[j])) break;
      search.push(lines[j]);
    }
    if (divider < 0) {
      errors.push(`Edit block at line ${startLine} has no ======= divider between SEARCH and REPLACE.`);
      i = Math.max(j, i + 1);
      continue;
    }

    const replace: string[] = [];
    let k = divider + 1;
    let closed = false;
    for (; k < lines.length; k++) {
      if (REPLACE_RE.test(lines[k])) {
        closed = true;
        break;
      }
      if (SEARCH_RE.test(lines[k])) break;
      replace.push(lines[k]);
    }
    if (!closed) {
      errors.push(
        `Edit block at line ${startLine} was not closed with >>>>>>> REPLACE (the reply may have been cut off).`
      );
      i = Math.max(k, i + 1);
      continue;
    }

    blocks.push({ target, search: search.join('\n'), replace: replace.join('\n'), line: startLine });
    i = k + 1;
  }
  return { blocks, errors };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export type MatchStrategy = 'exact' | 'whitespace' | 'fuzzy';

export interface HunkMatch {
  /** Matched region in the source, as a half-open line range [start, end). */
  start: number;
  end: number;
  strategy: MatchStrategy;
  /** 1 for exact/whitespace matches; similarity for fuzzy ones. */
  score: number;
  /** The replacement lines, re-indented to the matched region when the model drifted on indentation. */
  replacement: string[];
}

export interface ClosestMatch {
  start: number;
  end: number;
  score: number;
  text: string;
}

export type MatchFailure =
  | { ok: false; reason: 'empty-search'; detail: string }
  | { ok: false; reason: 'not-found'; detail: string; closest?: ClosestMatch }
  | { ok: false; reason: 'ambiguous'; detail: string; candidates: number[] };

export type MatchResult = { ok: true; match: HunkMatch } | MatchFailure;

const FUZZY_THRESHOLD = 0.85;
const FUZZY_MARGIN = 0.05;
/** Upper bound on (source lines x search lines) for the fuzzy pass, to keep matching instant. */
const FUZZY_MAX_WORK = 200_000;

function trimBlankEdges(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s].trim() === '') s++;
  while (e > s && lines[e - 1].trim() === '') e--;
  return lines.slice(s, e);
}

const normWs = (l: string) => l.trim().replace(/\s+/g, ' ');
const indentOf = (l: string) => l.match(/^[ \t]*/)![0];

function findAll(lines: string[], needle: string[], eq: (a: string, b: string) => boolean): number[] {
  const out: number[] = [];
  const n = needle.length;
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (!eq(lines[i + k], needle[k])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function reindent(replace: string[], searchIndent: string, actualIndent: string): string[] {
  if (searchIndent === actualIndent) return replace;
  return replace.map((line) => {
    if (line.trim() === '') return line;
    return line.startsWith(searchIndent) ? actualIndent + line.slice(searchIndent.length) : line;
  });
}

function firstNonEmpty(lines: string[]): number {
  const idx = lines.findIndex((l) => l.trim() !== '');
  return idx < 0 ? 0 : idx;
}

const bigramCache = new Map<string, Map<string, number>>();
function bigrams(s: string): Map<string, number> {
  const cached = bigramCache.get(s);
  if (cached) return cached;
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  if (bigramCache.size > 20_000) bigramCache.clear();
  bigramCache.set(s, m);
  return m;
}

/** Dice coefficient on character bigrams of whitespace-normalised lines (1 = identical). */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ma = bigrams(a);
  const mb = bigrams(b);
  let shared = 0;
  const [small, large] = ma.size <= mb.size ? [ma, mb] : [mb, ma];
  for (const [g, c] of small) {
    const o = large.get(g);
    if (o) shared += Math.min(c, o);
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

function fuzzyScan(
  lines: string[],
  needle: string[]
): { best?: { start: number; score: number }; second?: { start: number; score: number } } {
  const n = needle.length;
  if (lines.length < n || lines.length * n > FUZZY_MAX_WORK) return {};
  const normNeedle = needle.map(normWs);
  const normLines = lines.map(normWs);
  const scores: Array<{ start: number; score: number }> = [];
  for (let i = 0; i + n <= lines.length; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += lineSimilarity(normLines[i + k], normNeedle[k]);
    scores.push({ start: i, score: sum / n });
  }
  scores.sort((a, b) => b.score - a.score || a.start - b.start);
  const best = scores[0];
  // Runner-up must be a different place (not just the window shifted by a line or two).
  const second = scores.find((s) => Math.abs(s.start - best.start) >= n);
  return { best, second };
}

export function matchHunk(sourceLines: string[], hunk: { search: string; replace: string }): MatchResult {
  const search = trimBlankEdges(hunk.search.split('\n'));
  const replace = trimBlankEdges(hunk.replace.split('\n'));
  if (search.length === 0) {
    return {
      ok: false,
      reason: 'empty-search',
      detail: 'The SEARCH section is empty, so there is nothing to locate. Quote the lines to change.',
    };
  }
  const n = search.length;

  // 1. Exact.
  const exact = findAll(sourceLines, search, (a, b) => a === b);
  if (exact.length === 1) {
    return { ok: true, match: { start: exact[0], end: exact[0] + n, strategy: 'exact', score: 1, replacement: replace } };
  }
  if (exact.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: exact,
      detail: `The SEARCH text matches ${exact.length} places (lines ${exact.map((i) => i + 1).join(', ')}). Include more surrounding lines so it is unique.`,
    };
  }

  // 2. Whitespace-tolerant (trailing space, indentation drift, collapsed spacing).
  const ws = findAll(sourceLines, search, (a, b) => normWs(a) === normWs(b));
  if (ws.length === 1) {
    const start = ws[0];
    const fi = firstNonEmpty(search);
    const replacement = reindent(replace, indentOf(search[fi]), indentOf(sourceLines[start + fi]));
    return { ok: true, match: { start, end: start + n, strategy: 'whitespace', score: 1, replacement } };
  }
  if (ws.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: ws,
      detail: `The SEARCH text matches ${ws.length} places once whitespace is ignored (lines ${ws.map((i) => i + 1).join(', ')}). Include more surrounding lines so it is unique.`,
    };
  }

  // 3. Fuzzy (small typos / a line the model slightly misquoted), only when clearly the best place.
  const { best, second } = fuzzyScan(sourceLines, search);
  if (best && best.score >= FUZZY_THRESHOLD) {
    if (second && second.score > best.score - FUZZY_MARGIN) {
      return {
        ok: false,
        reason: 'ambiguous',
        candidates: [best.start, second.start],
        detail: `The SEARCH text only approximately matches, and two places look equally likely (lines ${best.start + 1} and ${second.start + 1}).`,
      };
    }
    const fi = firstNonEmpty(search);
    const replacement = reindent(replace, indentOf(search[fi]), indentOf(sourceLines[best.start + fi]));
    return {
      ok: true,
      match: { start: best.start, end: best.start + n, strategy: 'fuzzy', score: Math.min(0.99, Math.round(best.score * 100) / 100), replacement },
    };
  }

  const closest: ClosestMatch | undefined = best
    ? {
        start: best.start,
        end: best.start + n,
        score: Math.round(best.score * 100) / 100,
        text: sourceLines.slice(best.start, best.start + n).join('\n'),
      }
    : undefined;
  return {
    ok: false,
    reason: 'not-found',
    closest,
    detail: closest
      ? `The SEARCH text was not found. The closest region is at lines ${closest.start + 1}-${closest.end} (${Math.round(closest.score * 100)}% similar).`
      : 'The SEARCH text was not found in the current code.',
  };
}

// ---------------------------------------------------------------------------------------------
// Planning and applying hunks
// ---------------------------------------------------------------------------------------------

export interface HunkOutcome {
  hunkId: string;
  result: MatchResult;
}

export interface HunkPlan {
  /** Source split into lines, with CRLF normalised to LF. */
  lines: string[];
  eol: '\n' | '\r\n';
  outcomes: HunkOutcome[];
}

function splitSource(source: string): { lines: string[]; eol: '\n' | '\r\n' } {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return { lines: source.replace(/\r\n/g, '\n').split('\n'), eol };
}

/**
 * Locates every hunk against the *original* source (not sequentially), so each can be accepted or
 * rejected independently and the result does not depend on hunk order.
 */
export function planHunks(source: string, hunks: EditHunk[]): HunkPlan {
  const { lines, eol } = splitSource(source);
  return {
    lines,
    eol,
    outcomes: hunks.map((h) => ({ hunkId: h.id, result: matchHunk(lines, h) })),
  };
}

export interface ApplyResult {
  text: string;
  /** Hunk ids that were applied. */
  applied: string[];
  /** Hunks that were not applied, with why (not found, ambiguous, overlaps another hunk, not selected). */
  skipped: Array<{ hunkId: string; reason: string }>;
  changed: boolean;
}

export function applyHunks(source: string, hunks: EditHunk[], accepted?: ReadonlySet<string>): ApplyResult {
  const plan = planHunks(source, hunks);
  const skipped: ApplyResult['skipped'] = [];
  const candidates: Array<{ hunkId: string; match: HunkMatch }> = [];

  for (const o of plan.outcomes) {
    if (!o.result.ok) {
      skipped.push({ hunkId: o.hunkId, reason: o.result.detail });
    } else if (accepted && !accepted.has(o.hunkId)) {
      skipped.push({ hunkId: o.hunkId, reason: 'Not selected.' });
    } else {
      candidates.push({ hunkId: o.hunkId, match: o.result.match });
    }
  }

  candidates.sort((a, b) => a.match.start - b.match.start);
  const chosen: typeof candidates = [];
  let prevEnd = -1;
  for (const c of candidates) {
    if (c.match.start < prevEnd) {
      skipped.push({ hunkId: c.hunkId, reason: 'Overlaps another change in the same region.' });
      continue;
    }
    chosen.push(c);
    prevEnd = c.match.end;
  }

  if (chosen.length === 0) {
    return { text: source, applied: [], skipped, changed: false };
  }

  const out = plan.lines.slice();
  for (let i = chosen.length - 1; i >= 0; i--) {
    const { match } = chosen[i];
    out.splice(match.start, match.end - match.start, ...match.replacement);
  }
  let text = out.join('\n');
  if (plan.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return { text, applied: chosen.map((c) => c.hunkId), skipped, changed: text !== source };
}

// ---------------------------------------------------------------------------------------------
// Line diff (for the review UI and for comparing versions)
// ---------------------------------------------------------------------------------------------

export interface DiffOp {
  type: 'eq' | 'add' | 'del';
  text: string;
  /** 1-based line numbers in the old / new text. */
  aLine?: number;
  bLine?: number;
}

/** Above this many table cells the changed middle is shown as a plain remove+add instead of an LCS. */
const MAX_DIFF_CELLS = 2_500_000;

export function diffLines(a: string, b: string): DiffOp[] {
  const A = a.replace(/\r\n/g, '\n').split('\n');
  const B = b.replace(/\r\n/g, '\n').split('\n');

  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;

  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'eq', text: A[i], aLine: i + 1, bLine: i + 1 });

  const am = A.slice(pre, A.length - suf);
  const bm = B.slice(pre, B.length - suf);
  const n = am.length;
  const m = bm.length;

  if (n * m > MAX_DIFF_CELLS) {
    am.forEach((t, i) => ops.push({ type: 'del', text: t, aLine: pre + i + 1 }));
    bm.forEach((t, i) => ops.push({ type: 'add', text: t, bLine: pre + i + 1 }));
  } else if (n === 0 || m === 0) {
    am.forEach((t, i) => ops.push({ type: 'del', text: t, aLine: pre + i + 1 }));
    bm.forEach((t, i) => ops.push({ type: 'add', text: t, bLine: pre + i + 1 }));
  } else {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ type: 'eq', text: am[i], aLine: pre + i + 1, bLine: pre + j + 1 });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        ops.push({ type: 'del', text: am[i], aLine: pre + i + 1 });
        i++;
      } else {
        ops.push({ type: 'add', text: bm[j], bLine: pre + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ type: 'del', text: am[i], aLine: pre + i + 1 });
    for (; j < m; j++) ops.push({ type: 'add', text: bm[j], bLine: pre + j + 1 });
  }

  for (let k = 0; k < suf; k++) {
    const ai = A.length - suf + k;
    const bi = B.length - suf + k;
    ops.push({ type: 'eq', text: A[ai], aLine: ai + 1, bLine: bi + 1 });
  }
  return ops;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.type === 'add') added++;
    else if (o.type === 'del') removed++;
  }
  return { added, removed };
}

export type DiffRow = DiffOp | { type: 'gap'; count: number };

/** Keeps changed lines plus `context` unchanged lines around them; collapses the rest into gaps. */
export function collapseContext(ops: DiffOp[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.type === 'eq') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let gap = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (gap > 0) rows.push({ type: 'gap', count: gap });
      gap = 0;
      rows.push(o);
    } else {
      gap++;
    }
  });
  if (gap > 0 && rows.length > 0) rows.push({ type: 'gap', count: gap });
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Heuristic syntax check
// ---------------------------------------------------------------------------------------------

export interface SyntaxIssue {
  /** Stable identity without line numbers, so before/after issues can be compared. */
  key: string;
  message: string;
  line?: number;
}

type Family = 'c' | 'python' | 'sql' | 'none';

function familyOf(lang: SupportedLanguage): Family {
  switch (lang) {
    case 'typescript':
    case 'javascript':
    case 'java':
    case 'cpp':
    case 'go':
    case 'rust':
    case 'css':
      return 'c';
    case 'python':
      return 'python';
    case 'sql':
      return 'sql';
    default:
      return 'none';
  }
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/**
 * Walks `code` skipping strings and comments and reports unbalanced brackets and unterminated
 * strings/comments. It is deliberately conservative and language-light: regex literals, macros or
 * exotic syntax can confuse it, which is why callers compare before vs after instead of trusting it
 * on its own.
 */
function scanBrackets(code: string, lang: SupportedLanguage): SyntaxIssue[] {
  const fam = familyOf(lang);
  if (fam === 'none') return [];
  const issues: SyntaxIssue[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  const push = (key: string, message: string, line: number) => {
    if (issues.length < 6) issues.push({ key, message, line });
  };

  const lineComments = fam === 'c' ? lang !== 'css' : false;
  const hashComments = fam === 'python';
  const dashComments = fam === 'sql';
  const blockComments = fam === 'c' || fam === 'sql';
  const backtickStrings = lang === 'typescript' || lang === 'javascript' || lang === 'go';
  const tripleQuotes = fam === 'python';

  let line = 1;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (lineComments && ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (hashComments && ch === '#') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (dashComments && ch === '-' && next === '-') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (blockComments && ch === '/' && next === '*') {
      const startLine = line;
      i += 2;
      let closed = false;
      while (i < n) {
        if (code[i] === '*' && code[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (code[i] === '\n') line++;
        i++;
      }
      if (!closed) push('unterminated-comment', `Unterminated block comment starting at line ${startLine}`, startLine);
      continue;
    }

    if (tripleQuotes && (ch === '"' || ch === "'") && code[i + 1] === ch && code[i + 2] === ch) {
      const startLine = line;
      const q = ch.repeat(3);
      i += 3;
      let closed = false;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code.startsWith(q, i)) {
          i += 3;
          closed = true;
          break;
        }
        if (code[i] === '\n') line++;
        i++;
      }
      if (!closed) push('unterminated-string', `Unterminated triple-quoted string starting at line ${startLine}`, startLine);
      continue;
    }

    if (ch === '"' || ch === "'" || (backtickStrings && ch === '`')) {
      // Rust: 'a is a lifetime, 'x' / '\n' a char literal.
      if (lang === 'rust' && ch === "'") {
        const m = code.slice(i).match(/^'(\\.|[^\\'])'/);
        i += m ? m[0].length : 1;
        continue;
      }
      const startLine = line;
      const multiLine = ch === '`';
      i++;
      let closed = false;
      while (i < n) {
        const c = code[i];
        if (c === '\\' && lang !== 'sql' && !(lang === 'go' && ch === '`')) {
          if (code[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (c === ch) {
          i++;
          closed = true;
          break;
        }
        if (c === '\n') {
          if (!multiLine) break;
          line++;
        }
        i++;
      }
      if (!closed) push('unterminated-string', `Unterminated string starting at line ${startLine}`, startLine);
      continue;
    }

    if (ch in OPENERS) {
      stack.push({ ch, line });
    } else if (CLOSERS.has(ch)) {
      const top = stack.pop();
      if (!top) {
        push(`unexpected-${ch}`, `Unexpected '${ch}' at line ${line}`, line);
      } else if (OPENERS[top.ch] !== ch) {
        push(`mismatch-${ch}`, `'${ch}' at line ${line} does not match '${top.ch}' opened at line ${top.line}`, line);
      }
    }
    i++;
  }
  for (const open of stack) push(`unclosed-${open.ch}`, `Unclosed '${open.ch}' opened at line ${open.line}`, open.line);

  if (fam === 'python') {
    const mixed = /^(?: +\t|\t+ +)\S/m.test(code);
    if (mixed) push('mixed-indent', 'Indentation mixes tabs and spaces', 0);
  }
  return issues;
}

export function checkSyntax(code: string, lang: SupportedLanguage): SyntaxIssue[] {
  if (lang === 'json') {
    if (!code.trim()) return [];
    try {
      JSON.parse(code);
      return [];
    } catch (err) {
      return [{ key: 'json-parse', message: `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}` }];
    }
  }
  return scanBrackets(code, lang);
}

export interface SyntaxComparison {
  before: SyntaxIssue[];
  after: SyntaxIssue[];
  /** Issues present after the edit that the original did not have (counted per kind). */
  introduced: SyntaxIssue[];
}

export function compareSyntax(before: string, after: string, lang: SupportedLanguage): SyntaxComparison {
  const b = checkSyntax(before, lang);
  const a = checkSyntax(after, lang);
  const budget = new Map<string, number>();
  for (const issue of b) budget.set(issue.key, (budget.get(issue.key) ?? 0) + 1);
  const introduced: SyntaxIssue[] = [];
  for (const issue of a) {
    const left = budget.get(issue.key) ?? 0;
    if (left > 0) budget.set(issue.key, left - 1);
    else introduced.push(issue);
  }
  return { before: b, after: a, introduced };
}

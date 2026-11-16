import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  EmbeddingSetting, FileListResult, FileRead, GitOp, GitResult, RepoMapResult, SearchHit, SearchMode,
  SearchResult, SymbolHit, TreeEntry, WorkspaceInfo,
} from '../../src/types/workspace.ts';
import {
  LIMITS, bm25Search, buildBm25, fuseRanks, renderRepoMap, scanWorkspace,
  type Bm25Index, type Chunk, type ScanResult,
} from './indexer.ts';
import { WorkspaceError, isDeniedPath, languageOf, looksBinary, redactSecrets, resolveInside, resolveRoot } from './safety.ts';

const REFRESH_AFTER_MS = 20_000;
const MAX_EMBED_CHUNKS = 4000;
const EMBED_BATCH = 16;

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

interface WorkspaceState {
  root: string;
  name: string;
  scan: ScanResult;
  bm25: Bm25Index;
  scannedAt: number;
  vectors: Map<string, Float32Array>; // key: path:startLine:fileKey
  embed: { setting: EmbeddingSetting | null; state: 'idle' | 'running' | 'error' | 'off'; error?: string; token: number };
}

export interface WorkspaceManagerOptions {
  fetchImpl?: typeof fetch;
  gitTimeoutMs?: number;
}

const vecKey = (c: Chunk) => `${c.path}:${c.startLine}:${c.fileKey}`;

function normalize(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
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
  // fuzzy subsequence on the whole path
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

export function createWorkspaceManager(options: WorkspaceManagerOptions = {}) {
  const doFetch = options.fetchImpl ?? fetch;
  const gitTimeout = options.gitTimeoutMs ?? 8000;
  const states = new Map<string, WorkspaceState>();

  const buildState = (root: string, previous?: WorkspaceState): WorkspaceState => {
    const scan = scanWorkspace(root, { previous: previous?.scan });
    return {
      root,
      name: path.basename(root),
      scan,
      bm25: buildBm25(scan.chunks),
      scannedAt: Date.now(),
      vectors: previous?.vectors ?? new Map(),
      embed: previous?.embed ?? { setting: null, state: 'off', token: 0 },
    };
  };

  const get = (rawRoot: string): WorkspaceState => {
    const root = resolveRoot(rawRoot);
    const st = states.get(root);
    if (!st) throw new WorkspaceError('That project folder is not open. Open it first.', 409);
    return st;
  };

  const fresh = (st: WorkspaceState): WorkspaceState => {
    if (Date.now() - st.scannedAt < REFRESH_AFTER_MS) return st;
    const next = buildState(st.root, st);
    states.set(st.root, next);
    if (next.embed.setting) void runEmbedding(next);
    return next;
  };

  // ---- embeddings -------------------------------------------------------------------------------

  async function embedTexts(setting: EmbeddingSetting, input: string[]): Promise<Float32Array[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await doFetch(new URL('/api/embed', setting.baseUrl).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: setting.model, input }),
        signal: ctl.signal,
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Embedding model returned HTTP ${res.status}. Is "${setting.model}" installed (ollama pull ${setting.model})?`);
      const json = (await res.json()) as { embeddings?: number[][] };
      if (!Array.isArray(json.embeddings) || json.embeddings.length !== input.length) throw new Error('Embedding model returned an unexpected response.');
      return json.embeddings.map(normalize);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runEmbedding(st: WorkspaceState): Promise<void> {
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
        if (st.embed.token !== token || st.embed.setting !== setting) return; // superseded or closed
        const batch = todo.slice(i, i + EMBED_BATCH);
        const vecs = await embedTexts(setting, batch.map(([, c]) => `${c.path}\n${c.text}`.slice(0, 1800)));
        batch.forEach(([k], j) => st.vectors.set(k, vecs[j]));
      }
      st.embed.state = 'idle';
    } catch (e) {
      st.embed.state = 'error';
      st.embed.error = e instanceof Error ? e.message : 'Embedding failed.';
    }
  }

  // ---- public operations -------------------------------------------------------------------------

  const info = (st: WorkspaceState): WorkspaceInfo => ({
    rootPath: st.root,
    name: st.name,
    fileCount: st.scan.files.size,
    chunkCount: st.scan.chunks.length,
    totalBytes: st.scan.totalBytes,
    truncated: st.scan.truncated,
    isGit: fs.existsSync(path.join(st.root, '.git')),
    indexedAt: st.scannedAt,
    embeddings: {
      model: st.embed.setting?.model ?? '',
      embedded: st.vectors.size,
      total: Math.min(st.scan.chunks.length, MAX_EMBED_CHUNKS),
      state: st.embed.setting ? st.embed.state : 'off',
      error: st.embed.error,
    },
  });

  function setEmbedding(st: WorkspaceState, setting: EmbeddingSetting | null | undefined) {
    const next = setting && setting.model.trim() && isLoopbackHttpUrl(setting.baseUrl) ? { baseUrl: setting.baseUrl.replace(/\/+$/, ''), model: setting.model.trim() } : null;
    const cur = st.embed.setting;
    if (cur?.model === next?.model && cur?.baseUrl === next?.baseUrl) return;
    st.vectors.clear();
    st.embed = { setting: next, state: next ? 'idle' : 'off', token: st.embed.token + 1 };
    if (next) void runEmbedding(st);
  }

  return {
    async open(rawPath: string, embedding?: EmbeddingSetting | null): Promise<WorkspaceInfo> {
      const root = resolveRoot(rawPath);
      let st = states.get(root);
      st = buildState(root, st);
      states.set(root, st);
      setEmbedding(st, embedding);
      return info(st);
    },

    close(rawPath: string): void {
      states.delete(resolveRoot(rawPath));
    },

    info(rawRoot: string, embedding?: EmbeddingSetting | null): WorkspaceInfo {
      const st = fresh(get(rawRoot));
      if (embedding !== undefined) setEmbedding(st, embedding);
      return info(st);
    },

    files(rawRoot: string, query: string, limit = 8): FileListResult {
      const st = fresh(get(rawRoot));
      const q = String(query ?? '').trim();
      const lim = Math.max(1, Math.min(30, limit));
      const files = [...st.scan.files.values()]
        .map((f) => ({ f, s: scorePath(f.path, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.f.mtimeMs - a.f.mtimeMs)
        .slice(0, lim)
        .map(({ f }) => ({ path: f.path, size: f.size, language: f.language }));
      const dirs = q
        ? [...st.scan.dirs].map((d) => ({ d, s: scorePath(d, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.d.localeCompare(b.d)).slice(0, 4).map((x) => x.d)
        : [];
      return { files, dirs };
    },

    tree(rawRoot: string, dir = '', depth = 2): TreeEntry[] {
      const st = fresh(get(rawRoot));
      const base = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (base) resolveInside(st.root, base);
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
    },

    /** Reads one file (text only, redacted). `startLine`/`endLine` are 1-based and inclusive. */
    read(rawRoot: string, rel: string, startLine?: number, endLine?: number): FileRead {
      const st = get(rawRoot);
      const abs = resolveInside(st.root, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new WorkspaceError('That path is a folder; mention it as a folder instead.');
      if (stat.size > LIMITS.maxReadBytes) throw new WorkspaceError(`File is larger than ${Math.round(LIMITS.maxReadBytes / 1000)} KB; mention a line range or search instead.`, 413);
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) throw new WorkspaceError('Binary files cannot be attached.', 415);
      const redacted = redactSecrets(buf.toString('utf8').replace(/\r\n?/g, '\n'));
      const lines = redacted.text.split('\n');
      const from = Math.max(1, Math.floor(startLine ?? 1));
      const to = Math.min(lines.length, Math.floor(endLine ?? lines.length));
      if (from > lines.length) throw new WorkspaceError('Line range is past the end of the file.');
      const relReal = path.relative(st.root, abs).split(path.sep).join('/');
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
    },

    symbols(rawRoot: string, query: string, limit = 6): SymbolHit[] {
      const st = fresh(get(rawRoot));
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
      return scored.sort((a, b) => b.score - a.score || a.s.path.localeCompare(b.s.path)).slice(0, Math.max(1, Math.min(20, limit))).map((x) => x.s);
    },

    async search(rawRoot: string, query: string, mode: SearchMode = 'hybrid', limit = 6, embedding?: EmbeddingSetting | null): Promise<SearchResult> {
      let st = fresh(get(rawRoot));
      if (embedding !== undefined) setEmbedding(st, embedding);
      st = states.get(st.root)!;
      const lim = Math.max(1, Math.min(20, limit));
      const q = String(query ?? '').trim().slice(0, 2000);
      if (!q) return { hits: [], mode: 'lexical' };

      const lexical = mode === 'semantic' ? [] : bm25Search(st.scan.chunks, st.bm25, q, lim * 4);
      let semantic: Array<{ chunk: Chunk; score: number }> = [];
      if (mode !== 'lexical' && st.embed.setting && st.vectors.size > 0) {
        try {
          const [qv] = await embedTexts(st.embed.setting, [q.slice(0, 1800)]);
          for (const c of st.scan.chunks) {
            const v = st.vectors.get(vecKey(c));
            if (v) semantic.push({ chunk: c, score: dot(qv, v) });
          }
          semantic.sort((a, b) => b.score - a.score);
          semantic = semantic.slice(0, lim * 4).filter((x) => x.score > 0.2);
        } catch {
          semantic = [];
        }
      }

      const usedSemantic = semantic.length > 0;
      const rankedIds = (usedSemantic && lexical.length > 0)
        ? fuseRanks([lexical.map((x) => x.chunk.id), semantic.map((x) => x.chunk.id)])
        : new Map((usedSemantic ? semantic : lexical).map((x, i) => [x.chunk.id, 1 / (60 + i + 1)]));
      const inLex = new Set(lexical.map((x) => x.chunk.id));
      const inSem = new Set(semantic.map((x) => x.chunk.id));
      const best = [...rankedIds.entries()].sort((a, b) => b[1] - a[1]);

      // One hit per file keeps the context diverse; neighbouring chunks of a file are rarely both needed.
      const perFile = new Map<string, number>();
      const hits: SearchHit[] = [];
      for (const [id, score] of best) {
        const c = st.scan.chunks[id];
        const n = perFile.get(c.path) ?? 0;
        if (n >= 1) continue;
        perFile.set(c.path, n + 1);
        hits.push({
          path: c.path, startLine: c.startLine, endLine: c.endLine, text: c.text,
          score: Number(score.toFixed(5)),
          via: inLex.has(id) && inSem.has(id) ? 'both' : inSem.has(id) ? 'semantic' : 'lexical',
        });
        if (hits.length >= lim) break;
      }
      return { hits, mode: usedSemantic ? (lexical.length > 0 ? 'hybrid' : 'semantic') : 'lexical' };
    },

    repoMap(rawRoot: string, maxTokens = 800, focus: string[] = []): RepoMapResult {
      const st = fresh(get(rawRoot));
      const safeFocus = focus.filter((p) => typeof p === 'string' && !isDeniedPath(p)).slice(0, 20);
      return renderRepoMap(st.scan.files, Math.max(100, Math.min(4000, maxTokens)), safeFocus);
    },

    async git(rawRoot: string, op: GitOp): Promise<GitResult> {
      const st = get(rawRoot);
      if (!fs.existsSync(path.join(st.root, '.git'))) throw new WorkspaceError('This folder is not a Git repository.', 404);
      if (op !== 'status' && op !== 'diff') throw new WorkspaceError('Unsupported git operation.');
      const base = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager', '-c', 'diff.external='];
      const exclude = ['.env*', '*.pem', '*.key', 'id_rsa*', '*.p12', '*.pfx', '.npmrc', '.netrc', '*.sqlite', '*.sqlite3', '*.db', '*.gvbackup', '*.lock', 'package-lock.json']
        .map((g) => `:(exclude,glob)**/${g}`);
      const run = (args: string[]) =>
        new Promise<string>((resolve, reject) => {
          execFile('git', [...base, ...args], {
            cwd: st.root, timeout: gitTimeout, maxBuffer: 4_000_000,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
          }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        });
      let text: string;
      try {
        if (op === 'status') {
          text = await run(['status', '--short', '--branch', '--untracked-files=normal']);
        } else {
          const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3'];
          try {
            text = await run([...args, 'HEAD', '--', '.', ...exclude]);
          } catch {
            // no commits yet: show staged + unstaged separately
            text = (await run([...args, '--cached', '--', '.', ...exclude])) + (await run([...args, '--', '.', ...exclude]));
          }
        }
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'ENOENT') throw new WorkspaceError('Git is not installed or not on PATH.', 501);
        throw new WorkspaceError('Git could not read this repository.', 502);
      }
      const redacted = redactSecrets(text).text;
      const cap = 120_000;
      return { op, text: redacted.length > cap ? `${redacted.slice(0, cap)}\n…[diff truncated]` : redacted, truncated: redacted.length > cap };
    },
  };
}

export type WorkspaceManager = ReturnType<typeof createWorkspaceManager>;

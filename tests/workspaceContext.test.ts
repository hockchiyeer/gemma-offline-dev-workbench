import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGemmaMessages } from '../src/lib/contextEngine.ts';
import {
  assembleContextBlocks,
  buildMentionCandidates,
  describeUse,
  findMention,
  gatherWorkspaceContext,
  removeMention,
} from '../src/lib/workspaceContext.ts';
import type { WorkspaceConnection } from '../src/lib/workspaceClient.ts';
import type { ChatMessage, CodeSnippet, DocPage } from '../src/types/vault.ts';

const snippet: CodeSnippet = {
  id: 's1',
  projectId: 'p',
  title: 'Auth helper',
  language: 'typescript',
  code: 'export const ok = true;',
  notes: '',
  tags: ['auth'],
  favorite: false,
  createdAt: 1,
  updatedAt: 1,
};

const doc: DocPage = {
  id: 'd1',
  projectId: 'p',
  title: 'API Design',
  category: 'api',
  content: '# API',
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
};

test('findMention detects @tokens at valid boundaries and ignores email addresses', () => {
  assert.deepEqual(findMention('Explain @pay', 12), { start: 8, end: 12, query: 'pay' });
  assert.deepEqual(findMention('@pay', 4), { start: 0, end: 4, query: 'pay' });
  assert.equal(findMention('mail user@example.com', 21), null);
  assert.equal(findMention('Explain @pay and more', 21), null);
});

test('removeMention deletes the @token cleanly without leaving double or trailing spaces', () => {
  const m1 = findMention('Explain @pay', 12)!;
  assert.deepEqual(removeMention('Explain @pay', m1, 12), { text: 'Explain', caret: 7 });

  const m2 = findMention('Explain @pay please', 12)!;
  assert.deepEqual(removeMention('Explain @pay please', m2, 12), { text: 'Explain please', caret: 7 });

  const m3 = findMention('@pay', 4)!;
  assert.deepEqual(removeMention('@pay', m3, 4), { text: '', caret: 0 });
});

test('buildMentionCandidates ranks workspace files, folders, symbols, git options, snippets, and docs', () => {
  const out = buildMentionCandidates('pay', {
    workspace: true,
    files: [{ path: 'src/payments.ts', size: 1200, language: 'typescript' }],
    dirs: ['src/payments'],
    symbols: [{ name: 'retryPayment', kind: 'function', path: 'src/payments.ts', line: 10, signature: 'function retryPayment()' }],
    snippets: [snippet],
    docs: [doc],
  });
  assert.equal(out[0].label, 'src/payments.ts');
  assert.equal(out[1].category, 'Folder');
  assert.equal(out[2].category, 'Symbol');

  const gitOnly = buildMentionCandidates('diff', {
    workspace: true,
    snippets: [],
    docs: [],
  });
  assert.ok(gitOnly.some((c) => c.ref.kind === 'git' && c.ref.id === 'diff'));
});

test('gatherWorkspaceContext deduplicates search hits against @-mentioned files, respects excludeKeys, and keeps system prompt constant', async () => {
  const fakeConn = {
    read: async (p: string) => ({
      path: p,
      language: 'typescript',
      content: 'export function a() {}',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
      redactions: 0,
    }),
    search: async () => ({
      mode: 'lexical' as const,
      hits: [
        { path: 'src/a.ts', startLine: 1, endLine: 10, text: 'dup', score: 0.9, via: 'lexical' as const },
        { path: 'src/b.ts', startLine: 5, endLine: 20, text: 'export function b() {}', score: 0.7, via: 'lexical' as const },
        { path: 'src/c.ts', startLine: 1, endLine: 8, text: 'export function c() {}', score: 0.5, via: 'lexical' as const },
      ],
    }),
    repoMap: async () => ({ text: 'src/a.ts\n  function a()', files: 2, symbols: 2 }),
  } as unknown as WorkspaceConnection;

  const gathered = await gatherWorkspaceContext({
    conn: fakeConn,
    workspace: { path: '/tmp/my-repo', autoRetrieve: true, repoMap: true },
    question: 'how does b work?',
    refs: [{ kind: 'file', id: 'src/a.ts', title: 'src/a.ts' }],
    retrieveK: 4,
    mapTokens: 400,
    excludeKeys: new Set(['src/c.ts:1-8']),
  });

  assert.equal(gathered.mentioned.length, 1);
  assert.equal(gathered.retrieved.length, 1);
  assert.equal(gathered.retrieved[0].title, 'src/b.ts:5-20');
  assert.ok(gathered.map !== null);
  assert.match(describeUse(gathered.use), /1 mentioned, 1 found by search, project outline \(my-repo/);

  const blocks = assembleContextBlocks({ edit: null, vault: [], gathered });
  const user1: ChatMessage = { id: 'u1', role: 'user', content: 'Q1', createdAt: 1 };
  const payload1 = buildGemmaMessages('SYS', [user1], blocks, { contextTokens: 8192, reserveForReply: 1024 });
  assert.equal(payload1.messages[0].content, 'SYS');
  assert.ok(payload1.sentContext.includes('--- INSTRUCTIONS: Workspace notes ---'));
  assert.ok(payload1.sentContext.includes('--- FILE: src/a.ts ---'));
  assert.ok(payload1.sentContext.includes('--- RETRIEVED: src/b.ts:5-20 ---'));
});

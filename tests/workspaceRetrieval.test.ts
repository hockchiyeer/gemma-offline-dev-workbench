/**
 * Retrieval regression test: 20 natural-language questions about THIS repository, each with the file(s)
 * a developer would expect, run through the real workspace indexer and lexical search.
 *
 * The repository is copied to a temp folder first, without this file, so the questions cannot match
 * their own text and pollute the index. If you rename or move a file listed below, update the question
 * set (the test says which entry is stale) rather than loosening the thresholds.
 *
 * Set RETRIEVAL_REPORT=1 to print a per-question table.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceManager } from '../server/workspace/workspace.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(REPO, 'tests', 'workspaceRetrieval.test.ts');

/** [question, acceptable files (any one in the top results counts)] */
export const QUESTIONS: Array<[string, string[]]> = [
  ['how are SEARCH/REPLACE edit blocks parsed and matched', ['src/lib/editEngine.ts']],
  ['token estimation calibration per model', ['src/lib/tokenEstimate.ts']],
  ['build prompt messages within the context window budget', ['src/lib/contextEngine.ts']],
  ['summarize old chat turns when history is too long', ['src/lib/compaction.ts']],
  ['encrypt the vault with a passphrase', ['src/lib/crypto.ts']],
  ['save snippets and chat sessions to IndexedDB', ['src/lib/db.ts']],
  ['stream chat completions from Ollama and read reasoning tokens', ['src/lib/gemmaClient.ts']],
  ['install Ollama and pull a model in a setup job', ['server/ollamaSetup.ts']],
  ['reject requests with an unexpected Host header DNS rebinding', ['server.ts']],
  ['gitignore pattern matching rules', ['src/lib/workspaceCore.ts']],
  ['native operating system folder picker dialog', ['server/workspace/browse.ts']],
  ['showDirectoryPicker File System Access API fallback', ['src/lib/browserWorkspace.ts']],
  ['autocomplete popup for at mentions', ['src/components/MentionPopup.tsx', 'src/lib/workspaceContext.ts']],
  ['context meter showing tokens per second', ['src/components/ContextBar.tsx']],
  ['render a line diff with added and removed rows', ['src/components/DiffView.tsx', 'src/lib/editEngine.ts']],
  ['card to review a proposed edit then apply or undo', ['src/components/EditProposalCard.tsx']],
  ['child snippet versions derived from a parent', ['src/lib/snippetLineage.ts']],
  ['debounced save queue for writes', ['src/lib/saveQueue.ts']],
  ['automatically name a chat session from the first message', ['src/lib/sessionNaming.ts']],
  ['repository map ranked by import graph', ['src/lib/workspaceCore.ts']],
];

/** Copies the repo without dependencies, build output, VCS data, large assets, or this test itself. */
function copyRepo(dest: string): void {
  fs.cpSync(REPO, dest, {
    recursive: true,
    filter: (src) => {
      if (src === SELF) return false;
      const rel = path.relative(REPO, src).split(path.sep);
      return !['node_modules', '.git', 'dist', 'public', 'coverage'].includes(rel[0]);
    },
  });
}

let tmp = '';
const mgr = createWorkspaceManager({ watch: false });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-retrieval-')));
  copyRepo(tmp);
});
after(() => {
  mgr.close(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('retrieval regression: the right file is in the top 5 for 20 known questions about this repo', async () => {
  await mgr.open(tmp);

  const stale = QUESTIONS.flatMap(([q, want]) => want.filter((f) => !fs.existsSync(path.join(tmp, f))).map((f) => `"${q}" expects missing file ${f}`));
  assert.deepEqual(stale, [], 'the question set is out of date: update tests/workspaceRetrieval.test.ts');
  assert.equal(QUESTIONS.length, 20);

  let top1 = 0;
  let top5 = 0;
  const rows: string[] = [];
  const misses: string[] = [];
  for (const [question, want] of QUESTIONS) {
    const res = await mgr.search(tmp, question, 'lexical', 5);
    const paths = res.hits.map((h) => h.path);
    const rank = paths.findIndex((p) => want.includes(p));
    if (rank === 0) top1++;
    if (rank >= 0) top5++;
    else misses.push(`"${question}" -> wanted ${want.join(' | ')}; got ${paths.join(', ') || '(nothing)'}`);
    rows.push(`${rank === 0 ? ' #1 ' : rank > 0 ? ` #${rank + 1} ` : 'MISS'}  ${question}  ->  ${paths[0] ?? '-'}`);
  }
  if (process.env.RETRIEVAL_REPORT) console.log(`\ntop-1: ${top1}/20   top-5: ${top5}/20\n${rows.join('\n')}`);

  assert.deepEqual(misses, [], 'every question must find its file in the top 5');
  assert.ok(top1 >= MIN_TOP1, `top-1 accuracy fell to ${top1}/20 (floor ${MIN_TOP1}); ranking regressed`);
});

/** Floor for questions answered by the very first result. Raised as ranking improves; never lowered silently. */
const MIN_TOP1 = 13; // 12/20 before intent-aware ranking, 15/20 after

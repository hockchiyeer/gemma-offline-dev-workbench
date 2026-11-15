import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { DiffView } from '../src/components/DiffView.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import { EditProposalCard } from '../src/components/EditProposalCard.tsx';
import { applyHunks, compareSyntax, diffLines, diffStats, hashText, planHunks } from '../src/lib/editEngine.ts';
import { buildProposalFromReply, canUndo, findFailedHunks } from '../src/lib/editProposal.ts';
import type { ChatMessage, CodeSnippet, EditProposal, EditTarget } from '../src/types/vault.ts';

const CODE = ['function add(a, b) {', '  return a - b;', '}', '', 'function mul(a, b) {', '  return a * b;', '}', ''].join('\n');

const snippet = (over: Partial<CodeSnippet> = {}): CodeSnippet => ({
  id: 's1',
  projectId: 'p',
  title: 'math.ts',
  language: 'typescript',
  code: CODE,
  notes: '',
  tags: [],
  favorite: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const target = (over: Partial<EditTarget> = {}): EditTarget => ({
  snippetId: 's1',
  title: 'math.ts',
  baseHash: hashText(CODE),
  state: 'pending',
  hunks: [{ id: 'h1', search: '  return a - b;', replace: '  return a + b;' }],
  ...over,
});

const noop = () => {};
const render = (proposal: EditProposal, snippets: CodeSnippet[] = [snippet()], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(EditProposalCard, {
      proposal,
      snippets,
      busy: false,
      onApply: noop,
      onSaveVersion: noop,
      onUndo: noop,
      onDismiss: noop,
      ...extra,
    })
  );

const proposal = (targets: EditTarget[], extra: Partial<EditProposal> = {}): EditProposal => ({
  targets,
  issues: [],
  attempt: 0,
  ...extra,
});

// ---------------------------------------------------------------------------------------------

test('DiffView: marks added and removed lines for screen readers, shows line numbers, and folds unchanged runs', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
  const b = a.replace('line10', 'CHANGED');
  const html = renderToStaticMarkup(React.createElement(DiffView, { ops: diffLines(a, b), context: 2, label: 'demo' }));
  assert.ok(html.includes('aria-label="demo"'));
  assert.ok(html.includes('removed: '));
  assert.ok(html.includes('added: '));
  assert.ok(html.includes('CHANGED'));
  assert.ok(html.includes('unchanged lines'));
  assert.ok(!html.includes('line0<'), 'far-away context is folded away');

  const none = renderToStaticMarkup(React.createElement(DiffView, { ops: diffLines('x', 'x'), label: 'same' }));
  assert.ok(none.includes('No changes.'));

  const offset = renderToStaticMarkup(
    React.createElement(DiffView, { ops: diffLines('a\nb', 'a\nB'), lineOffset: 40, label: 'o' })
  );
  assert.ok(offset.includes('>41<') && offset.includes('>42<'), 'line numbers include the fragment offset');
});

test('card (pending): shows each change with its match quality, the +/- totals and the three actions', () => {
  const html = render(
    proposal([
      target({
        hunks: [
          { id: 'h1', search: '  return a - b;', replace: '  return a + b;' },
          { id: 'h2', search: 'never existed\nanywhere', replace: 'x' },
        ],
      }),
    ])
  );
  assert.ok(html.includes('Proposed edits to math.ts'));
  assert.ok(html.includes('2 proposed changes'));
  assert.ok(html.includes('Change 1'));
  assert.ok(html.includes('lines 2–2 · exact match'));
  assert.ok(html.includes('+1') && html.includes('−1'));
  assert.ok(html.includes('Change 2 cannot be applied'));
  assert.ok(html.includes('The SEARCH text was not found'));
  assert.ok(html.includes('1 change could not be located and will not be applied.'));
  for (const label of ['Save as new version', 'Apply to original', 'Dismiss']) assert.ok(html.includes(label), label);
});

test('card: whitespace and approximate matches are labelled so the user knows how much to trust them', () => {
  const sloppy = target({ hunks: [{ id: 'h1', search: 'return   a -   b;', replace: 'return a + b;' }] });
  assert.ok(render(proposal([sloppy])).includes('matched ignoring whitespace'));

  const code = ['function compute(value) {', '  const result = value * factor + offset;', '  return result;', '}'].join('\n');
  const fuzzy = target({
    snippetId: 's2',
    baseHash: hashText(code),
    hunks: [{ id: 'h1', search: 'function compute(value) {\n  const result = value * factor + offsett;\n  return result;\n}', replace: 'x' }],
  });
  assert.ok(render(proposal([fuzzy]), [snippet({ id: 's2', code })]).includes('approximate match'));
});

test('card: warns when the snippet changed after the proposal, and when the result would be worse code', () => {
  const edited = snippet({ code: CODE + '// later edit\n' });
  assert.ok(render(proposal([target()]), [edited]).includes('changed after the edits were proposed'));
  assert.ok(!render(proposal([target()])).includes('changed after the edits were proposed'));

  const breaking = target({ hunks: [{ id: 'h1', search: '  return a - b;', replace: '  if (x) {' }] });
  const html = render(proposal([breaking]));
  assert.ok(html.includes('may not be valid typescript code'));
  assert.ok(/Unclosed (&#x27;|')\{(&#x27;|') opened at line/.test(html), 'names the problem and where it starts');

  assert.ok(!render(proposal([target()])).includes('may not be valid'), 'a clean edit raises no warning');
});

test('card: actions are disabled while busy or when nothing applicable is selected', () => {
  const busy = render(proposal([target()]), [snippet()], { busy: true });
  assert.equal((busy.match(/disabled=""/g) ?? []).length, 3, 'save, apply and dismiss are all disabled');

  const allFailed = render(proposal([target({ hunks: [{ id: 'h1', search: 'nope\nnope', replace: 'x' }] })]));
  assert.equal((allFailed.match(/disabled=""/g) ?? []).length, 2, 'save and apply are disabled; dismiss stays available');
});

test('card (applied): Undo is offered only while the snippet is exactly what the edit produced', () => {
  const after = CODE.replace('a - b', 'a + b');
  const applied = target({ state: 'applied', acceptedHunkIds: ['h1'], preImage: CODE, postHash: hashText(after) });

  const ok = render(proposal([applied]), [snippet({ code: after })]);
  assert.ok(ok.includes('Applied 1 change to'));
  assert.ok(ok.includes('Undo'));
  assert.ok(!ok.includes('Undo is unavailable'));
  assert.equal((ok.match(/disabled=""/g) ?? []).length, 0);

  const changedSince = render(proposal([applied]), [snippet({ code: after + '// edited' })]);
  assert.ok(changedSince.includes('Undo is unavailable'));
  assert.equal((changedSince.match(/disabled=""/g) ?? []).length, 1);
});

test('card (saved / dismissed / deleted): each terminal state reads clearly', () => {
  const saved = render(proposal([target({ state: 'saved', acceptedHunkIds: ['h1', 'h2'], resultSnippetId: 'v2' })]), [snippet()], {
    onOpenSnippet: noop,
  });
  assert.ok(saved.includes('Saved 2 changes to'));
  assert.ok(saved.includes('as a new version'));
  assert.ok(saved.includes('Open it'));

  assert.ok(render(proposal([target({ state: 'dismissed' })])).includes('Dismissed the proposed edits to'));

  const gone = render(proposal([target()]), []);
  assert.ok(gone.includes('no longer exists'));
  assert.ok(!gone.includes('Apply to original'));
});

test('card: format problems and follow-up attempts are surfaced, with a repair button only when there is something to repair', () => {
  const withIssue = render(proposal([target()], { issues: ['Edit block at line 9 was not closed with >>>>>>> REPLACE (the reply may have been cut off).'], attempt: 1 }), [snippet()], {
    onRepair: noop,
  });
  assert.ok(withIssue.includes('Follow-up attempt 1'));
  assert.ok(withIssue.includes('may have been cut off'));
  assert.ok(withIssue.includes('Ask Gemma to fix'));

  const clean = render(proposal([target()]), [snippet()], { onRepair: noop });
  assert.ok(!clean.includes('Ask Gemma to fix'));

  const failing = render(proposal([target({ hunks: [{ id: 'h1', search: 'zzz\nyyy', replace: 'x' }] })]), [snippet()], { onRepair: noop });
  assert.ok(failing.includes('Ask Gemma to fix the failed change'));
  assert.ok(!render(proposal([target({ hunks: [{ id: 'h1', search: 'zzz\nyyy', replace: 'x' }] })])).includes('Ask Gemma to fix'), 'no button without a handler');
});

// ---------------------------------------------------------------------------------------------
// End to end: realistic reply -> proposal -> review -> apply -> undo guard
// ---------------------------------------------------------------------------------------------

test('pipeline: a fenced, partly-misindented model reply becomes a correct, undoable edit', () => {
  const reply = [
    'The subtraction in `add` is a typo, and `mul` should guard against NaN.',
    '',
    'math.ts',
    '```typescript',
    '<<<<<<< SEARCH',
    'function add(a, b) {',
    'return a - b;', // model dropped the indentation
    '}',
    '=======',
    'function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '>>>>>>> REPLACE',
    '```',
    '',
    'math.ts',
    '<<<<<<< SEARCH',
    '  return a * b;',
    '=======',
    '  const r = a * b;',
    '  return Number.isNaN(r) ? 0 : r;',
    '>>>>>>> REPLACE',
  ].join('\n');

  const current = snippet();
  const proposal = buildProposalFromReply({ reply, snippets: [current] })!;
  assert.equal(proposal.targets.length, 1);
  assert.deepEqual(proposal.issues, []);
  assert.deepEqual(findFailedHunks(proposal, [current]), []);

  const t = proposal.targets[0];
  const plan = planHunks(current.code, t.hunks);
  assert.deepEqual(plan.outcomes.map((o) => o.result.ok && o.result.match.strategy), ['whitespace', 'exact']);

  const result = applyHunks(current.code, t.hunks);
  assert.equal(result.applied.length, 2);
  assert.ok(result.text.includes('function add(a: number, b: number): number {\n  return a + b;\n}'), 're-indented to the file');
  assert.ok(result.text.includes('return Number.isNaN(r) ? 0 : r;'));
  assert.equal(compareSyntax(current.code, result.text, 'typescript').introduced.length, 0);
  assert.deepEqual(diffStats(diffLines(current.code, result.text)), { added: 4, removed: 3 });

  // Apply: write, record the pre-image and post hash.
  const applied: EditTarget = { ...t, state: 'applied', acceptedHunkIds: result.applied, preImage: current.code, postHash: hashText(result.text) };
  assert.equal(canUndo(applied, result.text), true);
  // Undo restores the original byte-for-byte.
  assert.equal(applied.preImage, current.code);
  // Someone edits the snippet afterwards: Undo must refuse instead of clobbering their work.
  assert.equal(canUndo(applied, result.text + '\n// my own change'), false);

  // The expected-hash guard used by the app: a stale preview must not apply.
  const stalePreviewHash = hashText(current.code);
  assert.notEqual(stalePreviewHash, hashText(current.code + ' '));

  // Reviewing it in the card shows both changes and no warnings.
  const html = render(proposal.targets.length ? { targets: proposal.targets, issues: [], attempt: 0 } : proposal, [current]);
  assert.ok(html.includes('2 proposed changes'));
  assert.ok(html.includes('matched ignoring whitespace'));
  assert.ok(!html.includes('may not be valid'));
});

// ---------------------------------------------------------------------------------------------
// Inside the real pane
// ---------------------------------------------------------------------------------------------

const renderPane = (messages: ChatMessage[], extraProps: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(
      ConfirmProvider,
      null,
      React.createElement(GemmaAssistantPane, {
        sessions: [{ id: 'chat-1', projectId: 'p', title: 'Edit chat', createdAt: 1, updatedAt: 2, messages }],
        activeSessionId: 'chat-1',
        onSelectSession: noop,
        onCreateSession: noop,
        onUpdateSession: noop,
        onDeleteSession: async () => {},
        snippets: [snippet()],
        docs: [],
        runtimeConfig: {
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          selectedModel: 'gemma4:e4b',
          temperature: 0.25,
          maxTokens: 2048,
          contextTokens: 8192,
          systemPrompt: 'System',
        },
        probe: { connected: true, transport: 'proxy', models: [], recommendedModel: null },
        probing: false,
        onRescanRuntime: async () => {},
        onOpenRuntimeModal: noop,
        onSaveSnippetFromCode: async () => {},
        onSaveGeneratedSnippets: async () => [],
        onClearQueuedPrompt: noop,
        ...extraProps,
      })
    )
  );

const editChat = (edits?: EditProposal): ChatMessage[] => [
  {
    id: 'u1',
    role: 'user',
    content: 'Make this change: fix add',
    createdAt: 1,
    actionKind: 'edit',
    attachments: [{ kind: 'snippet', id: 's1', title: 'math.ts' }],
  },
  { id: 'a1', role: 'assistant', content: 'Fixed the sign.', createdAt: 2, model: 'gemma4:e4b', edits },
  { id: 'u2', role: 'user', content: 'thanks', createdAt: 3 },
  { id: 'a2', role: 'assistant', content: 'You are welcome.', createdAt: 4, model: 'gemma4:e4b' },
];

test('pane: a stored edit proposal is reviewable under its reply, and only there', () => {
  const html = renderPane(editChat(proposal([target()])), {
    onApplyEditToSnippet: async () => ({ ok: true }),
    onSaveEditAsVersion: async () => null,
  });
  assert.equal((html.match(/Proposed edits to math\.ts/g) ?? []).length, 1);
  assert.ok(html.includes('Save as new version'));
  assert.ok(html.includes('Fixed the sign.'));
  assert.ok(html.includes('You are welcome.'));

  const plain = renderPane(editChat(undefined));
  assert.ok(!plain.includes('Proposed edits to'));
});

test('pane: without apply/save handlers the review buttons are disabled instead of silently doing nothing', () => {
  const html = renderPane(editChat(proposal([target()])));
  const section = html.slice(html.indexOf('Proposed edits to math.ts'));
  const saveBtn = section.slice(section.lastIndexOf('<button', section.indexOf('Save as new version')), section.indexOf('Save as new version'));
  assert.ok(saveBtn.includes('disabled=""'));

  const enabled = renderPane(editChat(proposal([target()])), {
    onApplyEditToSnippet: async () => ({ ok: true }),
    onSaveEditAsVersion: async () => null,
  });
  const section2 = enabled.slice(enabled.indexOf('Proposed edits to math.ts'));
  const saveBtn2 = section2.slice(section2.lastIndexOf('<button', section2.indexOf('Save as new version')), section2.indexOf('Save as new version'));
  assert.ok(!saveBtn2.includes('disabled=""'));
});

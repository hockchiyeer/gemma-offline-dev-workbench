import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KEEP_RECENT_TURNS,
  REQUEST_DELIMITER,
  buildGemmaMessages,
  fitToTokens,
  inputBudgetTokens,
  planCompaction,
  renderContextPack,
  renderUserTurn,
  truncateAtBoundary,
  type ContextBlock,
} from '../src/lib/contextEngine.ts';
import {
  DEFAULT_CALIBRATION,
  estimateTokens,
  getCalibration,
  openFenceAfter,
  recordCalibrationSample,
  resetCalibrationCache,
  updateCalibration,
} from '../src/lib/tokenEstimate.ts';
import type { ChatMessage, ConversationSummary } from '../src/types/vault.ts';

const BIG = { contextTokens: 32768, reserveForReply: 4096 };

let seq = 0;
const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `u${++seq}`,
  role: 'user',
  content,
  createdAt: seq,
  ...extra,
});
const assistant = (content: string): ChatMessage => ({
  id: `a${++seq}`,
  role: 'assistant',
  content,
  createdAt: seq,
});

const snippetBlock = (title: string, code: string): ContextBlock => ({
  title,
  kind: 'snippet',
  content: `\`\`\`ts\n${code}\n\`\`\``,
});

const fenceCount = (text: string) => text.split('\n').filter((l) => /^\s*(```|~~~)/.test(l)).length;

// ---------------------------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------------------------

test('estimator: code is denser than prose and CJK is about a token per character', () => {
  const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(20);
  const code = prose.replace(/ /g, ';').replace(/\.$/, '');
  const asCode = '```ts\n' + code + '\n```';
  assert.ok(estimateTokens(asCode) > estimateTokens(prose));

  const cjk = '这是一个关于本地模型上下文预算的测试句子。'.repeat(10); // 21 chars x 10
  const est = estimateTokens(cjk);
  assert.ok(est >= 200 && est <= 260, `CJK estimate should be ~1 token/char, got ${est}`);
  // A flat 3.2 chars/token heuristic would have said ~66 tokens: a 3x underestimate.
  assert.ok(est > cjk.length / 3.2 * 2.5);
});

test('estimator: calibration scale multiplies the estimate', () => {
  const text = 'function add(a, b) { return a + b; }\n'.repeat(30);
  assert.ok(estimateTokens(text, 2) > estimateTokens(text, 1) * 1.9);
});

test('calibration: completion samples move both ways; prompt samples cannot drift toward under-estimating', () => {
  let cal = { ...DEFAULT_CALIBRATION };
  // Model tokenises denser than assumed: prompt says 1500 observed vs 1000 estimated.
  cal = updateCalibration(cal, { estimatedTokens: 1000, observedTokens: 1500, promptSide: true });
  assert.ok(cal.scale > 1.2, `expected scale to rise, got ${cal.scale}`);

  // A cache-hit reading (only 100 of 1000 tokens evaluated) must be ignored on the prompt side.
  const before = cal.scale;
  cal = updateCalibration(cal, { estimatedTokens: 1000, observedTokens: 100, promptSide: true });
  assert.equal(cal.scale, before);

  // ...but a completion-side reading is trustworthy and may lower the scale.
  cal = updateCalibration(cal, { estimatedTokens: 1000, observedTokens: 700 });
  assert.ok(cal.scale < before);

  // Degenerate samples are ignored.
  assert.deepEqual(updateCalibration(cal, { estimatedTokens: 3, observedTokens: 900 }), cal);
  assert.deepEqual(updateCalibration(cal, { estimatedTokens: 500, observedTokens: 0 }), cal);
});

test('calibration persists per model through injected storage', () => {
  resetCalibrationCache();
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  recordCalibrationSample('model-a', { estimatedTokens: 1000, observedTokens: 1400 }, storage);
  const scaleA = getCalibration('model-a', storage).scale;
  assert.ok(scaleA > 1);
  assert.equal(getCalibration('model-b', storage).scale, 1);

  resetCalibrationCache(); // simulate a reload: value must come back from storage
  assert.equal(getCalibration('model-a', storage).scale, scaleA);

  resetCalibrationCache();
  store.set('gemmavault:tokcal:v1:model-a', '{not json');
  assert.equal(getCalibration('model-a', storage).scale, 1, 'corrupt storage falls back to defaults');
  resetCalibrationCache();
});

// ---------------------------------------------------------------------------------------------
// Safe truncation
// ---------------------------------------------------------------------------------------------

test('truncateAtBoundary never leaves a code fence open, at any cut position', () => {
  const doc = [
    'Intro line',
    '```ts',
    ...Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`),
    '```',
    'Between blocks',
    '~~~python',
    ...Array.from({ length: 12 }, (_, i) => `x${i} = ${i}`),
    '~~~',
    'Outro',
  ].join('\n');
  for (let cut = 0; cut <= doc.length; cut++) {
    const out = truncateAtBoundary(doc, cut);
    assert.equal(openFenceAfter(out), null, `fence left open at cut=${cut}`);
    assert.equal(fenceCount(out) % 2, 0, `odd fence count at cut=${cut}`);
  }
  assert.equal(truncateAtBoundary('short', 100), 'short');
});

test('fitToTokens respects the token limit and stays fence-safe', () => {
  const code = '```ts\n' + 'const x = 1;\n'.repeat(500) + '```';
  const fit = fitToTokens(code, 200);
  assert.equal(fit.truncated, true);
  assert.ok(estimateTokens(fit.text) <= 200);
  assert.equal(openFenceAfter(fit.text), null);
  assert.equal(fitToTokens('tiny', 200).truncated, false);
});

test('renderContextPack keeps whole blocks in priority order and names what it omitted', () => {
  const blocks = [
    snippetBlock('first.ts', 'a();\n'.repeat(40)),
    snippetBlock('second.ts', 'b();\n'.repeat(4000)),
    snippetBlock('third.ts', 'c();\n'.repeat(40)),
    snippetBlock('fourth.ts', 'd();\n'.repeat(40)),
  ];
  const pack = renderContextPack(blocks, 700);
  assert.equal(pack.truncated, true);
  assert.ok(pack.text.includes('first.ts'), 'highest-priority block kept');
  assert.ok(pack.text.includes('second.ts'), 'overflowing block is truncated, not dropped');
  assert.deepEqual(pack.omitted, ['third.ts', 'fourth.ts']);
  assert.ok(pack.text.includes('[omitted to fit local context window: third.ts, fourth.ts]'));
  assert.equal(openFenceAfter(pack.text), null);

  const all = renderContextPack(blocks.slice(0, 1), 5000);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.omitted, []);
});

// ---------------------------------------------------------------------------------------------
// Prefix stability (the property that makes local prompt caching work)
// ---------------------------------------------------------------------------------------------

test('prefix property: each request starts with the exact previous request (context changes every turn)', () => {
  const history: ChatMessage[] = [];
  const contexts: ContextBlock[][] = [
    [snippetBlock('a.ts', 'export const a = 1;')],
    [],
    [snippetBlock('b.ts', 'export const b = 2;'), snippetBlock('c.ts', 'export const c = 3;')],
    [snippetBlock('a.ts', 'export const a = 999; // edited since turn 1')],
    [],
  ];

  let previous: Array<{ role: string; content: string }> | null = null;
  contexts.forEach((blocks, turn) => {
    const u = user(`question ${turn}`);
    const built = buildGemmaMessages('SYSTEM', [...history, u], blocks, BIG);
    assert.equal(built.truncated, false);

    if (previous) {
      for (let i = 0; i < previous.length; i++) {
        assert.deepEqual(built.messages[i], previous[i], `turn ${turn}: message ${i} changed`);
      }
      assert.ok(built.messages.length > previous.length);
    }
    previous = built.messages;

    // What the app persists after sending.
    history.push({ ...u, sentContext: built.sentContext || undefined });
    history.push(assistant(`answer ${turn} with code\n\`\`\`ts\nlet x = ${turn};\n\`\`\``));
  });
});

test('the old attachment-in-system-prompt layout would have broken the prefix (regression guard)', () => {
  const u1 = user('first');
  const t1 = buildGemmaMessages('SYSTEM', [u1], [snippetBlock('a.ts', 'one')], BIG);
  const hist = [{ ...u1, sentContext: t1.sentContext }, assistant('ok'), user('second')];
  const t2 = buildGemmaMessages('SYSTEM', hist, [snippetBlock('b.ts', 'two')], BIG);
  // System message identical although the attachments differ between turns.
  assert.equal(t1.messages[0].content, 'SYSTEM');
  assert.equal(t2.messages[0].content, 'SYSTEM');
  assert.equal(t1.messages[0].content, t2.messages[0].content);
  // The new context rides on the latest user message only.
  assert.ok(t2.messages[t2.messages.length - 1].content.includes('b.ts'));
  assert.ok(!t2.messages.slice(0, -1).some((m) => m.content.includes('b.ts')));
});

test('context attaches to the latest user message with a request delimiter and is exposed for persistence', () => {
  const built = buildGemmaMessages('S', [user('Fix it')], [snippetBlock('a.ts', 'x')], BIG);
  const last = built.messages[built.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.startsWith('Attached Local Vault Context:'));
  assert.ok(last.content.endsWith(`${REQUEST_DELIMITER}Fix it`));
  assert.equal(last.content, renderUserTurn({ sentContext: built.sentContext, content: 'Fix it' }));

  const none = buildGemmaMessages('S', [user('hello')], [], BIG);
  assert.equal(none.sentContext, '');
  assert.equal(none.messages[none.messages.length - 1].content, 'hello');
});

test('placeholders and a leading assistant greeting are not replayed', () => {
  const greeting = assistant('Ready to assist offline!');
  const built = buildGemmaMessages(
    'S',
    [greeting, user('q1'), assistant(''), user('q2')],
    [],
    BIG
  );
  assert.deepEqual(
    built.messages.map((m) => `${m.role}:${m.content}`),
    ['system:S', 'user:q1', 'user:q2']
  );
});

// ---------------------------------------------------------------------------------------------
// Budget allocation
// ---------------------------------------------------------------------------------------------

test('budget: older turns are dropped whole, oldest first, never partially', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 12; i++) {
    history.push(user(`question ${i} ` + 'detail '.repeat(120)));
    history.push(assistant(`answer ${i} ` + 'text '.repeat(120)));
  }
  history.push(user('latest'));
  const built = buildGemmaMessages('S', history, [], { contextTokens: 4096, reserveForReply: 1024 });
  assert.ok(built.usage.droppedTurns > 0);
  assert.equal(built.truncated, true);
  const body = built.messages.slice(1, -1);
  assert.equal(body.length % 2, 0, 'only complete user+assistant turns');
  assert.equal(body[0].role, 'user');
  // Contiguous suffix: the kept turns are the most recent ones.
  const lastKept = body[body.length - 2].content;
  assert.ok(lastKept.startsWith('question 11'));
  const firstKeptIndex = 12 - body.length / 2;
  assert.ok(body[0].content.startsWith(`question ${firstKeptIndex}`));
  assert.ok(built.usage.totalTokens <= built.usage.inputBudget);
});

test('budget: history can use more than its share when there is no attached context', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    history.push(user(`q${i} ` + 'x '.repeat(2000)), assistant(`a${i} ` + 'y '.repeat(2000)));
  }
  history.push(user('latest'));
  const built = buildGemmaMessages('S', history, [], BIG);
  assert.equal(built.usage.droppedTurns, 0);
  assert.ok(built.usage.historyTokens > built.usage.historyCap, 'unused context share flows to history');
});

test('budget: context keeps its share against a long history, and whole turns still never split', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) {
    history.push(user(`q${i} ` + 'x '.repeat(500)), assistant(`a${i} ` + 'y '.repeat(500)));
  }
  history.push(user('latest'));
  const big = snippetBlock('big.ts', 'const v = 1;\n'.repeat(800));
  const built = buildGemmaMessages('S', history, [big], { contextTokens: 8192, reserveForReply: 2048 });
  assert.ok(built.usage.contextTokens > 0.3 * built.usage.inputBudget, 'context not starved by history');
  assert.ok(built.usage.contextTokens <= 0.5 * built.usage.inputBudget + 8);
  const last = built.messages[built.messages.length - 1].content;
  assert.equal(openFenceAfter(last), null, 'final prompt never ends inside an open fence');
  assert.equal(built.messages.slice(1, -1).length % 2, 0);
});

test('budget: an over-long latest message is trimmed to fit instead of overflowing the window', () => {
  const built = buildGemmaMessages('S', [user('z'.repeat(60_000))], [], { contextTokens: 4096, reserveForReply: 1024 });
  assert.equal(built.usage.trimmedLatest, true);
  assert.equal(built.truncated, true);
  assert.ok(built.usage.totalTokens <= built.usage.inputBudget + 16);
});

test('budget: legacy numeric budget and the default still work', () => {
  assert.equal(inputBudgetTokens(), 7500);
  assert.equal(inputBudgetTokens({ contextTokens: 8192, reserveForReply: 6144 }), 2048);
  assert.equal(inputBudgetTokens({ contextTokens: 2048, reserveForReply: 2000 }), 1024);
  assert.ok(inputBudgetTokens(24_000) >= 600);
  const built = buildGemmaMessages('S', [user('hi')], [], 24_000);
  assert.equal(built.messages.length, 2);
});

test('calibration scale makes the allocator more conservative', () => {
  const history = [user('q ' + 'word '.repeat(500)), assistant('a ' + 'word '.repeat(500)), user('latest')];
  const budget = { contextTokens: 4096, reserveForReply: 1500 };
  const plain = buildGemmaMessages('S', history, [], budget);
  const dense = buildGemmaMessages('S', history, [], budget, { calibration: { scale: 2 } });
  assert.ok(dense.usage.historyTokensAll > plain.usage.historyTokensAll * 1.8);
  assert.ok(dense.usage.droppedTurns >= plain.usage.droppedTurns);
});

// ---------------------------------------------------------------------------------------------
// Summary + compaction
// ---------------------------------------------------------------------------------------------

function longChat(turns: number, size = 150): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(user(`Q${i} ` + 'ask '.repeat(size)), assistant(`A${i} ` + 'reply '.repeat(size)));
  }
  return out;
}

test('summary replaces covered turns and is placed in the system message only', () => {
  const chat = longChat(5, 20);
  const summary: ConversationSummary = {
    text: '## Goal\nBuild the parser.',
    coversUpToMessageId: chat[5].id, // through A2
    updatedAt: 1,
  };
  const built = buildGemmaMessages('SYS', [...chat, user('next')], [], BIG, { summary });
  assert.ok(built.messages[0].content.startsWith('SYS'));
  assert.ok(built.messages[0].content.includes('Build the parser.'));
  assert.equal(built.usage.summaryActive, true);
  const text = built.messages.slice(1).map((m) => m.content).join('\n');
  assert.ok(!text.includes('Q0 ') && !text.includes('A2 '), 'covered turns are not replayed');
  assert.ok(text.includes('Q3 ') && text.includes('A4 '), 'turns after the summary are replayed');

  // A stale summary (covered message gone) is ignored rather than corrupting the prompt.
  const stale = buildGemmaMessages('SYS', [...chat, user('next')], [], BIG, {
    summary: { ...summary, coversUpToMessageId: 'does-not-exist' },
  });
  assert.equal(stale.messages[0].content, 'SYS');
  assert.equal(stale.usage.summaryActive, false);
});

test('planCompaction: quiet while history is small, triggers once it outgrows its share', () => {
  const input = inputBudgetTokens({ contextTokens: 16384, reserveForReply: 4096 }); // 12288
  assert.equal(planCompaction(longChat(1, 20), null, input), null);
  assert.equal(planCompaction(longChat(3, 40), null, input), null, 'under 60% of the history share');

  const chat = longChat(12, 200);
  const plan = planCompaction(chat, null, input);
  assert.ok(plan, 'expected a plan');
  assert.ok(plan.keptTurns >= 1 && plan.keptTurns <= KEEP_RECENT_TURNS);
  assert.equal(plan.fold.length % 2, 0);
  assert.equal(plan.fold[0].id, chat[0].id, 'folds from the oldest message');
  assert.equal(plan.coversUpToMessageId, plan.fold[plan.fold.length - 1].id);
  assert.equal(plan.fold[plan.fold.length - 1].role, 'assistant');
  // The kept turns are untouched and follow the fold directly.
  const keptStart = chat.findIndex((m) => m.id === plan.coversUpToMessageId) + 1;
  assert.equal(chat.length - keptStart, plan.keptTurns * 2);
});

test('planCompaction: builds on an existing summary, never re-folding covered turns', () => {
  const input = inputBudgetTokens({ contextTokens: 16384, reserveForReply: 4096 });
  const chat = longChat(14, 200);
  const first = planCompaction(chat, null, input)!;
  const summary: ConversationSummary = { text: 'note', coversUpToMessageId: first.coversUpToMessageId, updatedAt: 1 };
  // Immediately after compaction the remaining turns are within budget: nothing to do.
  assert.equal(planCompaction(chat, summary, input), null);

  const more = [...chat, ...longChat(8, 200)];
  const second = planCompaction(more, summary, input)!;
  assert.ok(second);
  const startIdx = more.findIndex((m) => m.id === first.coversUpToMessageId) + 1;
  assert.equal(second.fold[0].id, more[startIdx].id, 'second fold starts right after the first coverage');
  assert.ok(second.fold.every((m) => !first.fold.some((f) => f.id === m.id)));
});

test('planCompaction: tiny windows skip pointless model calls; force overrides the trigger', () => {
  const tiny = inputBudgetTokens({ contextTokens: 8192, reserveForReply: 6144 }); // 2048
  assert.equal(planCompaction(longChat(3, 30), null, tiny), null, 'fold too small to be worth a model call');

  const input = inputBudgetTokens({ contextTokens: 16384, reserveForReply: 4096 });
  const small = longChat(3, 10);
  assert.equal(planCompaction(small, null, input), null);
  const forced = planCompaction(small, null, input, 1, { force: true });
  assert.ok(forced);
  assert.ok(forced.keptTurns >= 1);
  assert.equal(planCompaction(longChat(1, 10), null, input, 1, { force: true }), null, 'nothing to fold with one turn');
});

test('after compaction the prompt is stable again: consecutive requests share their prefix', () => {
  const input = { contextTokens: 16384, reserveForReply: 4096 };
  const chat = longChat(12, 200);
  const plan = planCompaction(chat, null, inputBudgetTokens(input))!;
  const summary: ConversationSummary = { text: 'NOTE', coversUpToMessageId: plan.coversUpToMessageId, updatedAt: 1 };

  const history = [...chat];
  let previous: Array<{ role: string; content: string }> | null = null;
  for (let t = 0; t < 3; t++) {
    const u = user(`follow-up ${t}`);
    const built = buildGemmaMessages('SYS', [...history, u], [], input, { summary });
    assert.equal(built.usage.summaryActive, true);
    if (previous) {
      previous.forEach((m, i) => assert.deepEqual(built.messages[i], m));
    }
    previous = built.messages;
    history.push({ ...u, sentContext: built.sentContext || undefined }, assistant(`reply ${t}`));
  }
});

// ---------------------------------------------------------------------------------------------
// Slim fallback (tight windows must not lose earlier Q&A just because it carried an attachment)
// ---------------------------------------------------------------------------------------------

const bigCode = (tag: string, lines: number) =>
  '```ts\n' + Array.from({ length: lines }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n```';

test('slim fallback: an earlier turn that carried a big attachment keeps its Q&A instead of vanishing', () => {
  const tight = { contextTokens: 8192, reserveForReply: 6144 }; // app defaults: ~2k prompt tokens
  const sent = `Attached Local Vault Context:\n--- SNIPPET: parse.ts (ts) ---\n${bigCode('p', 150)}`;
  const earlier = [user('Q1: why NaN?', { sentContext: sent }), assistant('A1: add a guard.')];
  const built = buildGemmaMessages(
    'sys',
    [...earlier, user('Q2: review lexer too')],
    [{ title: 'lexer.ts', kind: 'snippet', content: bigCode('l', 300) }],
    tight
  );
  const all = built.messages.map((m) => m.content).join('\n');
  assert.ok(all.includes('Q1: why NaN?') && all.includes('A1: add a guard.'), 'earlier Q&A retained');
  assert.ok(all.includes('[attached: SNIPPET: parse.ts (ts)]'), 'attachment replaced by a marker');
  assert.ok(!all.includes('export const p100'), 'attachment body not replayed');
  assert.equal(built.usage.slimmedTurns, 1);
  assert.equal(built.usage.droppedTurns, 0);
  assert.equal(built.truncated, true);
  assert.ok(built.usage.totalTokens <= built.usage.inputBudget);
});

test('slim fallback never fires when everything fits, so the byte-identical prefix is preserved', () => {
  const sent = `Attached Local Vault Context:\n--- SNIPPET: a.ts (ts) ---\n${bigCode('a', 40)}`;
  const earlier = [user('Q1', { sentContext: sent }), assistant('A1')];
  const built = buildGemmaMessages('sys', [...earlier, user('Q2')], [], BIG);
  assert.equal(built.usage.slimmedTurns, 0);
  assert.equal(built.messages[1].content, renderUserTurn(earlier[0]));
  assert.ok(built.messages[1].content.includes('export const a39'));
});

test('slim fallback: a turn too big even when slimmed is dropped whole, and older turns never resurface behind it', () => {
  const tiny = { contextTokens: 2048, reserveForReply: 1000 }; // 1048 prompt tokens
  const hist = [
    user('OLDEST short question'), assistant('short answer'),
    user('Q-mid ' + 'long '.repeat(800)), assistant('A-mid ' + 'long '.repeat(800)),
    user('recent q'), assistant('recent a'),
  ];
  const built = buildGemmaMessages('sys', [...hist, user('now')], [], tiny);
  const all = built.messages.map((m) => m.content).join('\n');
  assert.ok(all.includes('recent q'));
  assert.ok(!all.includes('Q-mid'));
  assert.ok(!all.includes('OLDEST'), 'no gap: nothing older than a dropped turn is kept');
  assert.equal(built.usage.droppedTurns, 2);
});

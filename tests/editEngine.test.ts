import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyHunks,
  checkSyntax,
  collapseContext,
  compareSyntax,
  diffLines,
  diffStats,
  hashText,
  matchHunk,
  parseEditBlocks,
  planHunks,
} from '../src/lib/editEngine.ts';
import {
  EDIT_FORMAT_INSTRUCTIONS,
  EDIT_INSTRUCTION_BLOCK,
  buildProposalFromReply,
  buildRepairPrompt,
  canUndo,
  findFailedHunks,
  repairPromptFor,
  resolveTarget,
} from '../src/lib/editProposal.ts';
import { shouldAutoSaveChildSnippets, formatActionLabel } from '../src/lib/snippetLineage.ts';
import { renderContextPack } from '../src/lib/contextEngine.ts';
import type { EditTarget } from '../src/types/vault.ts';

const block = (target: string | null, search: string, replace: string) =>
  `${target ? `${target}\n` : ''}<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

const SRC = [
  'import { x } from "./x";',
  '',
  'function add(a, b) {',
  '  return a - b;',
  '}',
  '',
  'function mul(a, b) {',
  '  return a * b;',
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------------------------

test('hashText is stable, content-sensitive and fixed-width', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.notEqual(hashText('abc'), hashText('abc '));
  assert.notEqual(hashText(''), hashText('\n'));
  assert.equal(hashText('').length, 14);
  assert.equal(hashText('x'.repeat(100_000)).length, 14);
});

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

test('parse: a labelled block, with and without a surrounding code fence', () => {
  const plain = parseEditBlocks(`Fixing the sign.\n\n${block('utils.ts', 'a', 'b')}\n`);
  assert.equal(plain.errors.length, 0);
  assert.deepEqual(plain.blocks.map((b) => [b.target, b.search, b.replace]), [['utils.ts', 'a', 'b']]);

  const fenced = parseEditBlocks('utils.ts\n```ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```');
  assert.equal(fenced.blocks.length, 1);
  assert.equal(fenced.blocks[0].target, 'utils.ts');
  assert.equal(fenced.blocks[0].search, 'old');
});

test('parse: several blocks, label clean-up, CRLF replies, and multi-line bodies keep their indentation', () => {
  const reply = [
    '**`File: a.ts`**',
    '<<<<<<< SEARCH',
    '  indented();',
    '    deeper();',
    '=======',
    '  changed();',
    '>>>>>>> REPLACE',
    '',
    '### b.ts:',
    '<<<<<<< SEARCH',
    'x',
    '=======',
    '>>>>>>> REPLACE',
  ].join('\r\n');
  const { blocks, errors } = parseEditBlocks(reply);
  assert.equal(errors.length, 0);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].target, 'a.ts');
  assert.equal(blocks[0].search, '  indented();\n    deeper();');
  assert.equal(blocks[1].target, 'b.ts');
  assert.equal(blocks[1].replace, '', 'empty REPLACE means delete');
});

test('parse: malformed or truncated blocks are reported, never turned into partial edits', () => {
  const noDivider = parseEditBlocks('<<<<<<< SEARCH\nold\n>>>>>>> REPLACE');
  assert.equal(noDivider.blocks.length, 0);
  assert.match(noDivider.errors[0], /no ======= divider/);

  const cut = parseEditBlocks(`${block('a.ts', 'ok', 'fine')}\n\na.ts\n<<<<<<< SEARCH\nold\n=======\nhalf a repl`);
  assert.equal(cut.blocks.length, 1, 'the complete block before the cut-off survives');
  assert.match(cut.errors[0], /not closed|cut off/);

  assert.deepEqual(parseEditBlocks('just prose, no blocks'), { blocks: [], errors: [] });
});

// ---------------------------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------------------------

const lines = SRC.split('\n');

test('match: exact, unique match with line range', () => {
  const r = matchHunk(lines, { search: '  return a - b;', replace: '  return a + b;' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.match.strategy, 'exact');
    assert.equal(r.match.start, 3);
    assert.equal(r.match.end, 4);
    assert.deepEqual(r.match.replacement, ['  return a + b;']);
  }
});

test('match: surrounding blank lines in SEARCH are tolerated', () => {
  const r = matchHunk(lines, { search: '\n  return a - b;\n\n', replace: '\n  return a + b;\n' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual([r.match.start, r.match.end], [3, 4]);
});

test('match: a SEARCH that occurs twice is ambiguous and names the lines', () => {
  const r = matchHunk(lines, { search: '}', replace: '};' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'ambiguous');
    assert.match(r.detail, /2 places/);
    assert.deepEqual(r.reason === 'ambiguous' && r.candidates, [4, 8]);
  }
});

test('match: whitespace drift (trailing spaces, collapsed spacing) still matches', () => {
  const src = ['function f() {', '  const  x =   1;   ', '  return x;', '}'];
  const r = matchHunk(src, { search: '  const x = 1;\n  return x;', replace: '  const x = 2;\n  return x;' });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.match.strategy, 'whitespace');
});

test('match: when the model drops the indentation, the replacement is re-indented to fit', () => {
  const src = ['class A {', '    run() {', '        old();', '    }', '}'];
  const r = matchHunk(src, { search: 'old();', replace: 'neu();\nmore();' });
  // "old();" is unique after trimming -> whitespace strategy; replacement picks up the 8-space indent.
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.match.strategy, 'whitespace');
    assert.deepEqual(r.match.replacement, ['        neu();', '        more();']);
  }

  // Nested structure keeps its relative indentation.
  const r2 = matchHunk(src, { search: 'if (a) {\n  old();\n}', replace: 'if (a) {\n  neu();\n}' });
  assert.equal(r2.ok, false, 'a block that is not actually in the file is not invented');
});

test('match: relative indentation survives re-indenting', () => {
  const src = ['  if (ok) {', '    go();', '  }'];
  const r = matchHunk(src, { search: 'if (ok) {\n  go();\n}', replace: 'if (ok) {\n  go();\n  log();\n}' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.match.replacement, ['  if (ok) {', '    go();', '    log();', '  }']);
});

test('match: fuzzy handles a slightly misquoted line, but only when it is clearly the best place', () => {
  const src = [
    'function compute(value) {',
    '  const result = value * factor + offset;',
    '  return result;',
    '}',
    '',
    'function unrelated() {',
    '  return "nothing to see";',
    '}',
  ];
  const r = matchHunk(src, {
    search: 'function compute(value) {\n  const result = value * factor + offsett;\n  return result;\n}',
    replace: 'function compute(value) {\n  return value * factor;\n}',
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.match.strategy, 'fuzzy');
    assert.ok(r.match.score >= 0.85 && r.match.score < 1);
    assert.deepEqual([r.match.start, r.match.end], [0, 4]);
  }
});

test('match: a SEARCH unlike anything in the file fails, and reports the closest region', () => {
  const r = matchHunk(lines, { search: 'completely different code\nnothing alike here', replace: 'x' });
  assert.equal(r.ok, false);
  if (!r.ok && r.reason === 'not-found') {
    assert.match(r.detail, /not found/i);
    assert.ok(r.closest && r.closest.score < 0.85);
  } else {
    assert.fail('expected not-found');
  }
});

test('match: an empty SEARCH is rejected instead of matching everywhere', () => {
  const r = matchHunk(lines, { search: '  \n', replace: 'anything' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'empty-search');
});

// ---------------------------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------------------------

test('apply: several hunks land in the right places regardless of order', () => {
  const hunks = [
    { id: 'h1', search: '  return a * b;', replace: '  return a * b * 1;' },
    { id: 'h2', search: '  return a - b;', replace: '  return a + b;\n  // fixed' },
  ];
  const r = applyHunks(SRC, hunks);
  assert.deepEqual(r.applied.sort(), ['h1', 'h2']);
  assert.ok(r.text.includes('  return a + b;\n  // fixed\n}'));
  assert.ok(r.text.includes('  return a * b * 1;'));
  assert.equal(r.changed, true);
  const reversed = applyHunks(SRC, [...hunks].reverse());
  assert.equal(reversed.text, r.text);
});

test('apply: hunks are located in the ORIGINAL text, so one hunk cannot break another', () => {
  // h2's SEARCH quotes lines h1 rewrites; matched against the original it still resolves, then it
  // overlaps h1 and is reported instead of corrupting the file.
  const hunks = [
    { id: 'h1', search: 'function add(a, b) {\n  return a - b;\n}', replace: 'const add = (a, b) => a + b;' },
    { id: 'h2', search: '  return a - b;', replace: '  return a + b;' },
  ];
  const r = applyHunks(SRC, hunks);
  assert.deepEqual(r.applied, ['h1']);
  assert.deepEqual(r.skipped.map((s) => s.hunkId), ['h2']);
  assert.match(r.skipped[0].reason, /Overlaps/);
  assert.ok(r.text.includes('const add = (a, b) => a + b;'));
  assert.ok(!r.text.includes('a - b'));
});

test('apply: only accepted hunks are applied; the rest are reported as not selected', () => {
  const hunks = [
    { id: 'h1', search: '  return a - b;', replace: '  return a + b;' },
    { id: 'h2', search: '  return a * b;', replace: '  return 0;' },
  ];
  const r = applyHunks(SRC, hunks, new Set(['h1']));
  assert.deepEqual(r.applied, ['h1']);
  assert.ok(r.text.includes('return a * b;'));
  assert.deepEqual(r.skipped, [{ hunkId: 'h2', reason: 'Not selected.' }]);

  const none = applyHunks(SRC, hunks, new Set());
  assert.equal(none.text, SRC);
  assert.equal(none.changed, false);
});

test('apply: failed hunks do not block the ones that matched', () => {
  const r = applyHunks(SRC, [
    { id: 'ok', search: '  return a - b;', replace: '  return a + b;' },
    { id: 'bad', search: 'nowhere to be found\nat all', replace: 'x' },
  ]);
  assert.deepEqual(r.applied, ['ok']);
  assert.equal(r.skipped[0].hunkId, 'bad');
});

test('apply: CRLF files stay CRLF; a missing final newline stays missing; untouched text is byte-identical', () => {
  const crlf = 'a\r\nb\r\nc\r\n';
  const r = applyHunks(crlf, [{ id: 'h', search: 'b', replace: 'B\nB2' }]);
  assert.equal(r.text, 'a\r\nB\r\nB2\r\nc\r\n');

  const noFinal = 'x\ny';
  assert.equal(applyHunks(noFinal, [{ id: 'h', search: 'y', replace: 'z' }]).text, 'x\nz');

  const untouched = applyHunks(crlf, [{ id: 'h', search: 'nope nope', replace: 'x' }]);
  assert.equal(untouched.text, crlf);
});

test('apply: deletion (empty REPLACE) and insertion (quote an anchor, repeat it) both work', () => {
  const del = applyHunks('a\nremove me\nb', [{ id: 'h', search: 'remove me', replace: '' }]);
  assert.equal(del.text, 'a\nb', 'deleting removes the line cleanly, leaving no blank line behind');

  const ins = applyHunks('start\nend', [{ id: 'h', search: 'start', replace: 'start\nmiddle' }]);
  assert.equal(ins.text, 'start\nmiddle\nend');
});

test('planHunks exposes per-hunk outcomes for the review UI', () => {
  const plan = planHunks(SRC, [
    { id: 'a', search: '  return a - b;', replace: 'x' },
    { id: 'b', search: 'zzz\nyyy', replace: 'x' },
  ]);
  assert.equal(plan.outcomes[0].result.ok, true);
  assert.equal(plan.outcomes[1].result.ok, false);
  assert.equal(plan.eol, '\n');
});

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------

test('diff: identical text has no changes; additions and removals are counted with line numbers', () => {
  assert.deepEqual(diffStats(diffLines('a\nb', 'a\nb')), { added: 0, removed: 0 });

  const ops = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  const del = ops.find((o) => o.type === 'del')!;
  assert.deepEqual([del.text, del.aLine], ['b', 2]);
  const adds = ops.filter((o) => o.type === 'add');
  assert.deepEqual(adds.map((o) => [o.text, o.bLine]), [['B', 2], ['e', 5]]);
});

test('diff: reconstructs both sides exactly (property check over random edits)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let t = 0; t < 40; t++) {
    const a = Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => `l${Math.floor(rnd() * 6)}`);
    const b = a.filter(() => rnd() > 0.25);
    for (let k = 0; k < Math.floor(rnd() * 5); k++) b.splice(Math.floor(rnd() * (b.length + 1)), 0, `n${Math.floor(rnd() * 4)}`);
    const ops = diffLines(a.join('\n'), b.join('\n'));
    assert.equal(ops.filter((o) => o.type !== 'add').map((o) => o.text).join('\n'), a.join('\n'));
    assert.equal(ops.filter((o) => o.type !== 'del').map((o) => o.text).join('\n'), b.join('\n'));
  }
});

test('diff: very large unrelated inputs degrade to remove+add instead of hanging', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 3000, removed: 3000 });
});

test('collapseContext keeps changes plus context and folds the rest into gaps', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line${i}`);
  const b = a.slice();
  b[15] = 'CHANGED';
  const rows = collapseContext(diffLines(a.join('\n'), b.join('\n')), 2);
  assert.equal(rows[0].type, 'gap');
  assert.equal((rows[0] as { count: number }).count, 13);
  assert.equal(rows.filter((r) => r.type === 'del').length, 1);
  assert.equal(rows[rows.length - 1].type, 'gap');
  assert.equal(collapseContext([], 3).length, 0);
});

// ---------------------------------------------------------------------------------------------
// syntax heuristics
// ---------------------------------------------------------------------------------------------

test('syntax: balanced code passes; strings and comments containing brackets are ignored', () => {
  const ts = [
    'function f(a: number) {',
    '  // a stray ) in a comment',
    '  const s = "closing } in a string";',
    "  const t = '(';",
    '  /* { multi',
    '     line [ */',
    '  return `tpl ${a}`;',
    '}',
  ].join('\n');
  assert.deepEqual(checkSyntax(ts, 'typescript'), []);
});

test('syntax: unclosed, unexpected and mismatched brackets are reported with lines', () => {
  assert.match(checkSyntax('function f() {\n  if (x) {\n}', 'typescript')[0].message, /Unclosed '\{' opened at line 1/);
  assert.match(checkSyntax('foo());', 'javascript')[0].message, /Unexpected '\)'/);
  assert.match(checkSyntax('const a = [1, 2);', 'typescript')[0].message, /does not match '\['/);
  assert.match(checkSyntax('/* never closed', 'java')[0].message, /Unterminated block comment/);
  assert.match(checkSyntax('const s = "oops;\nnext();', 'typescript')[0].message, /Unterminated string/);
});

test('syntax: language quirks do not cause false alarms (Rust lifetimes, CSS urls, Python triple quotes, SQL)', () => {
  assert.deepEqual(checkSyntax("fn pick<'a>(x: &'a str) -> &'a str { let c = '{'; x }", 'rust'), []);
  assert.deepEqual(checkSyntax('a { background: url(http://x.test/y.png); }', 'css'), []);
  assert.deepEqual(checkSyntax('def f():\n    """doc with ( and { inside"""\n    return [1]\n', 'python'), []);
  assert.deepEqual(checkSyntax("SELECT 'it''s (fine)' -- trailing ( comment\nFROM t;", 'sql'), []);
  assert.match(checkSyntax('x = """never closed', 'python')[0].message, /triple-quoted/);
  assert.match(checkSyntax('if x:\n \tfoo()\n', 'python')[0].message, /tabs and spaces/);
});

test('syntax: JSON is parsed; unsupported languages are never flagged', () => {
  assert.deepEqual(checkSyntax('{"a": [1, 2]}', 'json'), []);
  assert.match(checkSyntax('{"a": }', 'json')[0].message, /Invalid JSON/);
  assert.deepEqual(checkSyntax('{{{ ((( ', 'markdown'), []);
  assert.deepEqual(checkSyntax('{{{ ((( ', 'yaml'), []);
});

test('compareSyntax only blames the edit for problems it introduced', () => {
  const before = 'function f() {\n  go(;\n}';
  const stillBroken = 'function f() {\n  go(;\n  more();\n}';
  assert.equal(compareSyntax(before, stillBroken, 'typescript').introduced.length, 0);

  const worse = 'function f() {\n  go(;\n  if (x) {\n}';
  const cmp = compareSyntax(before, worse, 'typescript');
  assert.ok(cmp.introduced.length >= 1);

  const good = 'function f() {\n  go();\n}';
  const fixed = compareSyntax(before, good, 'typescript');
  assert.equal(fixed.introduced.length, 0);
  assert.ok(fixed.before.length > fixed.after.length);
});

// ---------------------------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------------------------

const snippets = [
  { id: 's1', title: 'utils.ts', code: SRC },
  { id: 's2', title: 'Parser Core', code: 'export const parse = () => 1;\n' },
];

test('resolveTarget: exact, case-insensitive, language suffix and partial titles; ambiguity yields nothing', () => {
  assert.equal(resolveTarget('utils.ts', snippets), 's1');
  assert.equal(resolveTarget('UTILS.TS', snippets), 's1');
  assert.equal(resolveTarget('parser core (typescript)', snippets), 's2');
  assert.equal(resolveTarget('Parser', snippets), 's2');
  assert.equal(resolveTarget('nope.ts', snippets), undefined);
  assert.equal(resolveTarget(undefined, snippets), undefined);
  assert.equal(resolveTarget('v', [{ id: 'a', title: 'v1 foo' }, { id: 'b', title: 'v2 bar' }]), undefined);
});

test('proposal: blocks are grouped per snippet with stable ids and a base hash', () => {
  const reply = [
    'Two fixes.',
    block('utils.ts', '  return a - b;', '  return a + b;'),
    block('Parser Core', 'export const parse = () => 1;', 'export const parse = () => 2;'),
    block('utils.ts', '  return a * b;', '  return a * b * 2;'),
  ].join('\n\n');
  const p = buildProposalFromReply({ reply, snippets })!;
  assert.equal(p.attempt, 0);
  assert.deepEqual(p.issues, []);
  assert.equal(p.targets.length, 2);
  const utils = p.targets.find((t) => t.snippetId === 's1')!;
  assert.deepEqual(utils.hunks.map((h) => h.id), ['h1', 'h3']);
  assert.equal(utils.baseHash, hashText(SRC));
  assert.equal(utils.state, 'pending');
});

test('proposal: an unlabeled block goes to the only attached snippet; with several it is reported', () => {
  const unlabeled = block(null, '  return a - b;', '  return a + b;');
  const single = buildProposalFromReply({ reply: unlabeled, snippets: [snippets[0]] })!;
  assert.equal(single.targets[0].snippetId, 's1');

  const multi = buildProposalFromReply({ reply: unlabeled, snippets })!;
  assert.equal(multi.targets.length, 0);
  assert.match(multi.issues[0], /did not say which snippet/);

  const unknown = buildProposalFromReply({ reply: block('ghost.ts', 'a', 'b'), snippets })!;
  assert.match(unknown.issues[0], /ghost\.ts/);
});

test('proposal: no blocks -> null (caller falls back); malformed-only replies still surface the problem', () => {
  assert.equal(buildProposalFromReply({ reply: 'Here is some prose and ```ts\ncode\n```', snippets }), null);
  const bad = buildProposalFromReply({ reply: '<<<<<<< SEARCH\nx\n=======\ny', snippets })!;
  assert.equal(bad.targets.length, 0);
  assert.equal(bad.issues.length, 1);
});

test('failed hunks are found against the snippet CURRENT code and feed a repair prompt', () => {
  const p = buildProposalFromReply({
    reply: [block('utils.ts', '  return a - b;', '  return a + b;'), block('utils.ts', 'this is not in the file\nat all', 'x')].join('\n\n'),
    snippets,
  })!;
  const failed = findFailedHunks(p, snippets);
  assert.deepEqual(failed.map((f) => f.hunkId), ['h2']);

  const prompt = buildRepairPrompt(failed);
  assert.match(prompt, /Re-send ONLY those blocks/);
  assert.match(prompt, /utils\.ts: The SEARCH text was not found/);
  assert.match(prompt, /began with: this is not in the file/);

  // The snippet changed after the proposal: the previously good hunk now fails too.
  const edited = [{ ...snippets[0], code: SRC.replace('a - b', 'subtract(a, b)') }, snippets[1]];
  assert.deepEqual(findFailedHunks(p, edited).map((f) => f.hunkId).sort(), ['h1', 'h2']);

  // Handled targets are not retried.
  const applied = { ...p, targets: p.targets.map((t) => ({ ...t, state: 'applied' as const })) };
  assert.deepEqual(findFailedHunks(applied, snippets), []);
});

test('canUndo requires the snippet to still be exactly what the edit produced', () => {
  const after = 'new code';
  const target: EditTarget = {
    snippetId: 's',
    title: 't',
    baseHash: 'x',
    hunks: [],
    state: 'applied',
    preImage: 'old code',
    postHash: hashText(after),
  };
  assert.equal(canUndo(target, after), true);
  assert.equal(canUndo(target, after + ' edited later'), false);
  assert.equal(canUndo(target, undefined), false);
  assert.equal(canUndo({ ...target, state: 'pending' }, after), false);
  assert.equal(canUndo({ ...target, preImage: undefined }, after), false);
});

test('edit instructions: document the format and travel as the first context block', () => {
  assert.match(EDIT_FORMAT_INSTRUCTIONS, /<<<<<<< SEARCH/);
  assert.match(EDIT_FORMAT_INSTRUCTIONS, />>>>>>> REPLACE/);
  // The example in the instructions must itself be parseable and applicable.
  const { blocks } = parseEditBlocks(EDIT_FORMAT_INSTRUCTIONS);
  assert.equal(blocks.length, 2, 'the format description and the example both contain markers');
  const example = blocks[blocks.length - 1];
  assert.equal(example.target, 'utils.ts');

  const pack = renderContextPack([EDIT_INSTRUCTION_BLOCK, { title: 'utils.ts (typescript)', kind: 'snippet', content: SRC }], 10_000);
  assert.ok(pack.text.indexOf('INSTRUCTIONS: Edit format') < pack.text.indexOf('SNIPPET: utils.ts'));
});

test("'edit' is a first-class action: labelled, and never auto-saved as child snippets", () => {
  assert.equal(formatActionLabel('edit'), 'Edit');
  assert.equal(shouldAutoSaveChildSnippets('edit'), false);
  assert.equal(shouldAutoSaveChildSnippets('refactor'), true);
  assert.equal(shouldAutoSaveChildSnippets('explain'), false);
});

test('repairPromptFor covers failed matches, malformed blocks, both, and the nothing-to-do case', () => {
  const good = buildProposalFromReply({ reply: block('utils.ts', '  return a - b;', '  return a + b;'), snippets })!;
  assert.equal(repairPromptFor(good, snippets), null);

  const failing = buildProposalFromReply({ reply: block('utils.ts', 'not in file\nat all', 'x'), snippets })!;
  assert.match(repairPromptFor(failing, snippets)!, /Re-send ONLY those blocks/);

  const malformed = buildProposalFromReply({ reply: '<<<<<<< SEARCH\nx\n=======\ny', snippets })!;
  const p = repairPromptFor(malformed, snippets)!;
  assert.match(p, /Problems with the edit format/);
  assert.match(p, /not closed/);

  const both = { ...failing, issues: ['An edit block at line 9 did not say which snippet it changes.'] };
  const pb = repairPromptFor(both, snippets)!;
  assert.match(pb, /Failed blocks:/);
  assert.match(pb, /did not say which snippet/);
});

test('proposal: common ways models label a block all resolve to the right snippet (multi-snippet, no fallback)', () => {
  const two = [
    { id: 'a', title: 'math.ts', code: 'export const one = 1;\n' },
    { id: 'b', title: 'Parser Core', code: 'export const two = 2;\n' },
  ];
  const body = '<<<<<<< SEARCH\nexport const one = 1;\n=======\nexport const one = 11;\n>>>>>>> REPLACE';
  const labels = [
    'math.ts',
    '**math.ts**',
    '`math.ts`',
    '### math.ts',
    '#### `math.ts`',
    'File: math.ts',
    'math.ts (typescript)',
    'math.ts (typescript):',
    '--- SNIPPET: math.ts (typescript) ---',
  ];
  for (const label of labels) {
    const p = buildProposalFromReply({ reply: `Done.\n\n${label}\n${body}`, snippets: two })!;
    assert.equal(p.issues.length, 0, `label "${label}": ${p.issues.join('; ')}`);
    assert.equal(p.targets[0]?.snippetId, 'a', `label "${label}"`);
  }
  // Language-tagged fence that carries the file name, e.g. ```typescript:math.ts
  const fenced = buildProposalFromReply({ reply: '```typescript:math.ts\n' + body + '\n```', snippets: two })!;
  assert.equal(fenced.targets[0]?.snippetId, 'a');
  // Titles with spaces and mixed case.
  const spaced = buildProposalFromReply({ reply: `parser core\n${body.replace('one = 1', 'two = 2').replace('one = 11', 'two = 22')}`, snippets: two })!;
  assert.equal(spaced.targets[0]?.snippetId, 'b');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSnippetTree,
  createChildSnippets,
  extractFencedCodeBlocks,
  inferActionKindFromPrompt,
} from '../src/lib/snippetLineage.ts';
import type { CodeSnippet } from '../src/types/vault.ts';

function makeSnippet(overrides: Partial<CodeSnippet> & { id: string; title: string }): CodeSnippet {
  return {
    projectId: 'proj-core',
    language: 'typescript',
    code: 'export const x = 1;',
    notes: '',
    tags: ['core'],
    favorite: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('extractFencedCodeBlocks parses single, multiple, and nested fences while ignoring empty blocks', () => {
  const md = [
    'Here is the expanded solution:',
    '',
    '```ts',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '```',
    '',
    '```python',
    '   ',
    '```',
    '',
    'And the usage test:',
    '````typescript',
    'console.log(add(2, 3));',
    '````',
  ].join('\n');

  const blocks = extractFencedCodeBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].language, 'typescript');
  assert.match(blocks[0].code, /return a \+ b;/);
  assert.equal(blocks[1].language, 'typescript');
  assert.equal(blocks[1].code, 'console.log(add(2, 3));');
});

test('createChildSnippets generates single or multiple traceable children beneath parent', () => {
  const parent = makeSnippet({
    id: 'snip-root',
    title: 'WebCrypto Sealed Payload',
    version: 1,
    tags: ['crypto'],
  });

  const blocks = extractFencedCodeBlocks([
    '```typescript\nexport function fixed() { return true; }\n```',
    '```typescript\nassert(fixed() === true);\n```',
  ].join('\n\n'));

  let seq = 0;
  const children = createChildSnippets({
    parent,
    blocks,
    actionKind: 'unit-tests',
    prompt: 'Write comprehensive unit tests',
    model: 'gemma4:e4b',
    now: 5000,
    makeId: () => `snip-child-${++seq}`,
  });

  assert.equal(children.length, 2);
  assert.equal(children[0].parentId, 'snip-root');
  assert.equal(children[1].parentId, 'snip-root');
  assert.equal(children[0].version, 2);
  assert.equal(children[1].version, 2);
  assert.equal(children[0].derivedAction, 'unit-tests');
  assert.equal(children[0].title, 'v2 Unit Tests (1/2) · WebCrypto Sealed Payload');
  assert.equal(children[1].title, 'v2 Unit Tests (2/2) · WebCrypto Sealed Payload');
  assert.ok(children[0].tags.includes('crypto'));
  assert.ok(children[0].tags.includes('unit-tests'));
  assert.match(children[0].notes, /Derived via Unit Tests from "WebCrypto Sealed Payload" \(v1\)/);
  assert.match(children[0].notes, /Model: gemma4:e4b/);
});

test('createChildSnippets preserves parent language when fence omits language and increments nested versions', () => {
  const child = makeSnippet({
    id: 'snip-child',
    parentId: 'snip-root',
    title: 'v2 Refactor · SQLite Writer',
    language: 'python',
    version: 2,
    derivedAction: 'refactor',
  });

  const blocks = extractFencedCodeBlocks('```\ndef expanded_writer():\n    pass\n```');
  const grandchildren = createChildSnippets({
    parent: child,
    blocks,
    actionKind: 'expand',
    prompt: 'Expand stub',
    now: 9000,
    makeId: () => 'snip-grandchild',
  });

  assert.equal(grandchildren.length, 1);
  assert.equal(grandchildren[0].parentId, 'snip-child');
  assert.equal(grandchildren[0].version, 3);
  assert.equal(grandchildren[0].language, 'python');
  assert.equal(grandchildren[0].title, 'v3 Expand · SQLite Writer');
  assert.match(grandchildren[0].notes, /from "v2 Refactor · SQLite Writer" \(v2\)/);
});

test('buildSnippetTree nests children chronologically beneath parents and handles filtered orphans safely', () => {
  const root1 = makeSnippet({ id: 'r1', title: 'Root One', createdAt: 100 });
  const root2 = makeSnippet({ id: 'r2', title: 'Root Two', createdAt: 200 });
  const c1 = makeSnippet({ id: 'c1', parentId: 'r1', title: 'Child 1', version: 2, createdAt: 300 });
  const c2 = makeSnippet({ id: 'c2', parentId: 'r1', title: 'Child 2', version: 2, createdAt: 250 });
  const g1 = makeSnippet({ id: 'g1', parentId: 'c2', title: 'Grandchild 1', version: 3, createdAt: 400 });

  const all = [root1, c1, c2, g1, root2];
  const tree = buildSnippetTree(all, all);

  assert.deepEqual(
    tree.map((n) => [n.snippet.id, n.depth, n.childCount]),
    [
      ['r1', 0, 2],
      ['c2', 1, 1],
      ['g1', 2, 0],
      ['c1', 1, 0],
      ['r2', 0, 0],
    ]
  );

  // Filtered view where parent r1 is excluded promotes direct child while preserving parentTitle
  const filteredTree = buildSnippetTree([c2, g1], all);
  assert.deepEqual(
    filteredTree.map((n) => [n.snippet.id, n.depth, n.parentTitle]),
    [
      ['c2', 0, 'Root One'],
      ['g1', 1, 'Child 2'],
    ]
  );
});

test('inferActionKindFromPrompt detects all snippet actions', () => {
  assert.equal(inferActionKindFromPrompt('Explain how this snippet works step-by-step'), 'explain');
  assert.equal(inferActionKindFromPrompt('Audit this snippet for potential bugs'), 'debug');
  assert.equal(inferActionKindFromPrompt('Refactor this snippet for clarity'), 'refactor');
  assert.equal(inferActionKindFromPrompt('Implement or expand this snippet based on comments'), 'expand');
  assert.equal(inferActionKindFromPrompt('Write comprehensive unit tests'), 'unit-tests');
  assert.equal(inferActionKindFromPrompt('Translate this into another idiom', 'expand'), 'expand');
  assert.equal(inferActionKindFromPrompt('Make it asynchronous'), 'chat');
});

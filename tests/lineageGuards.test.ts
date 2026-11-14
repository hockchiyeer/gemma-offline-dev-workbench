import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractFencedCodeBlocks,
  shouldAutoSaveChildSnippets,
} from '../src/lib/snippetLineage.ts';

test('extractFencedCodeBlocks ignores a fence that never closes (truncated reply)', () => {
  const truncated = 'Refactor:\n```ts\nexport async function seal(\n  secret: string,\n  payl';
  assert.deepEqual(extractFencedCodeBlocks(truncated), []);
});

test('extractFencedCodeBlocks keeps closed blocks and drops only the unclosed tail', () => {
  const md = '```ts\nconst a = 1;\n```\ntext\n```ts\nconst b = ';
  const blocks = extractFencedCodeBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].code, 'const a = 1;');
});

test('extractFencedCodeBlocks still handles ~~~ fences and longer fences', () => {
  const md = '~~~py\nprint(1)\n~~~\n````md\n```inner```\n````';
  assert.equal(extractFencedCodeBlocks(md).length, 2);
});

test('explain replies are not auto-saved as child snippets; code-producing actions are', () => {
  assert.equal(shouldAutoSaveChildSnippets('explain'), false);
  for (const k of ['debug', 'refactor', 'expand', 'unit-tests', 'chat'] as const) {
    assert.equal(shouldAutoSaveChildSnippets(k), true, k);
  }
});

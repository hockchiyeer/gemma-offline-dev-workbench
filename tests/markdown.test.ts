import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from '../src/components/MarkdownRenderer.tsx';

const render = (content: string) =>
  renderToStaticMarkup(React.createElement(MarkdownRenderer, { content }));

// Each of these used to loop forever (and exhaust memory) because no block rule consumed the line.
const PREVIOUSLY_HANGING_INPUTS: Array<[string, string]> = [
  ['table header before its separator row has streamed in', 'Here is the table:\n| Name | Value |'],
  ['shebang line outside a code fence', '#!/bin/bash\necho hi'],
  ['preprocessor-style line', '#include <stdio.h>'],
  ['heading deeper than level 4', '##### Deep heading'],
  ['bare hash', '#'],
  ['hash followed by a single space', '# '],
  ['table header only, then blank', '| a | b |\n\nafter'],
];

for (const [name, input] of PREVIOUSLY_HANGING_INPUTS) {
  test(`MarkdownRenderer terminates on ${name}`, () => {
    const html = render(input);
    assert.ok(html.length > 0);
    assert.ok(html.length < 10_000, 'output must stay proportional to input');
  });
}

test('MarkdownRenderer still renders normal markdown', () => {
  const html = render('# Title\n\nSome **bold** text\n\n- a\n- b\n\n| h1 | h2 |\n|---|---|\n| x | y |');
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<strong[^>]*>bold<\/strong>/);
  assert.match(html, /<li>a<\/li>/);
  assert.match(html, /<table/);
});

test('MarkdownRenderer keeps the stray line text visible', () => {
  assert.match(render('#!/bin/bash\necho hi'), /#!\/bin\/bash echo hi/);
});

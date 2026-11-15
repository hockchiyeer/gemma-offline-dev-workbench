import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextBar } from '../src/components/ContextBar.tsx';
import type { ContextUsage } from '../src/lib/contextEngine.ts';

const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  inputBudget: 2048,
  systemTokens: 40,
  historyTokens: 300,
  historyTokensAll: 300,
  historyCap: 716,
  contextTokens: 500,
  latestTokens: 60,
  totalTokens: 900,
  droppedTurns: 0,
  slimmedTurns: 0,
  omittedContext: [],
  summaryActive: false,
  trimmedLatest: false,
  ...over,
});

const render = (props: Partial<React.ComponentProps<typeof ContextBar>> = {}) =>
  renderToStaticMarkup(
    React.createElement(ContextBar, {
      usage: usage(),
      streaming: false,
      compacting: false,
      onCompactNow: () => {},
      onCancelCompaction: () => {},
      onSaveSummary: () => {},
      onClearSummary: () => {},
      ...props,
    })
  );

test('ContextBar shows usage, speed and the condense action', () => {
  const html = render({ lastStats: { tokensPerSecond: 18.4 } });
  assert.ok(html.includes('Context ≈ 900 / 2.0k tokens'));
  assert.ok(html.includes('18.4 tok/s'));
  assert.ok(html.includes('Condense chat'));
  assert.ok(html.includes('aria-valuenow="44"'));
  assert.ok(!html.includes('Summary'), 'no summary link without a summary');
});

test('ContextBar warns about turns and attachments that do not fit, and flags a full window', () => {
  const html = render({
    usage: usage({ totalTokens: 2040, droppedTurns: 2, omittedContext: ['a.ts'] }),
  });
  assert.ok(html.includes('2 older turns won&#x27;t fit') || html.includes("2 older turns won't fit"));
  assert.ok(html.includes('1 attachment left out'));
  assert.ok(html.includes('bg-red-500'));
});

test('ContextBar tells the user when older attachments were shortened', () => {
  const html = render({ usage: usage({ slimmedTurns: 2 }) });
  assert.ok(html.includes('2 earlier attachments shortened'));
  assert.ok(!render({ usage: usage({ slimmedTurns: 0 }) }).includes('shortened'));
});

test('ContextBar offers the summary and a stop control while condensing', () => {
  const html = render({
    summary: { text: '## Goal\nx', coversUpToMessageId: 'm1', updatedAt: 1, model: 'gemma4:e4b' },
    compacting: true,
  });
  assert.ok(html.includes('Summary'));
  assert.ok(html.includes('Condensing… (stop)'));
  assert.ok(!html.includes('Condense chat'));
});

test('ContextBar renders nothing without usage', () => {
  assert.equal(render({ usage: null }), '');
});

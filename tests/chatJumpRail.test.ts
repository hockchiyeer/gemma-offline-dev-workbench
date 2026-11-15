import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatThreadJumpRail,
  buildTurnPreview,
  extractConversationTurns,
} from '../src/components/ChatThreadJumpRail.tsx';
import type { ChatMessage } from '../src/types/vault.ts';

const makeMsg = (id: string, role: 'user' | 'assistant', content: string, createdAt = 1000): ChatMessage => ({
  id,
  role,
  content,
  createdAt,
});

test('extractConversationTurns numbers user turns sequentially and skips assistant messages', () => {
  const turns = extractConversationTurns([
    makeMsg('a0', 'assistant', 'Welcome!'),
    makeMsg('u1', 'user', 'First prompt on Playwright'),
    makeMsg('a1', 'assistant', 'Here are your tests'),
    makeMsg('u2', 'user', 'Second prompt with a much longer description that spans beyond the short chip label length'),
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].id, 'u1');
  assert.equal(turns[0].index, 1);
  assert.equal(turns[0].shortLabel, 'First prompt on Playwright');
  assert.equal(turns[1].id, 'u2');
  assert.equal(turns[1].index, 2);
  assert.ok(turns[1].shortLabel.endsWith('...'));
  assert.ok(turns[1].shortLabel.length <= 38);
});

test('buildTurnPreview truncates long conversations cleanly with ellipsis', () => {
  const short = buildTurnPreview('Short prompt');
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'Short prompt');

  const long = buildTurnPreview('word '.repeat(80), 80);
  assert.equal(long.truncated, true);
  assert.ok(long.text.endsWith('...'));
  assert.ok(long.text.length <= 84);
});

test('ChatThreadJumpRail renders resting dash rail and expanded jump chip + tooltip preview', () => {
  const turns = extractConversationTurns([
    makeMsg('u1', 'user', 'Explain WebCrypto AES-GCM framing'),
    makeMsg('a1', 'assistant', 'Explanation'),
    makeMsg('u2', 'user', 'Refactor this function into 10 Cucumber Java BDD cases with boundary conditions and error handling '.repeat(4), 2000),
  ]);

  const restingHtml = renderToStaticMarkup(
    React.createElement(ChatThreadJumpRail, {
      turns,
      activeTurnId: 'u1',
      onJumpToTurn: () => {},
    })
  );
  assert.ok(restingHtml.includes('aria-label="Conversation turns quick jump"'));
  assert.ok(restingHtml.includes('Jump to turn 1: Explain WebCrypto AES-GCM framing'));
  assert.ok(!restingHtml.includes('role="tooltip"'));

  const expandedHtml = renderToStaticMarkup(
    React.createElement(ChatThreadJumpRail, {
      turns,
      activeTurnId: 'u2',
      onJumpToTurn: () => {},
      defaultExpanded: true,
      defaultHoveredId: 'u2',
    })
  );
  assert.ok(expandedHtml.includes('aria-label="Conversation turn navigator"'));
  assert.ok(expandedHtml.includes('Chat Turns (2)'));
  assert.ok(expandedHtml.includes('aria-current="location"'));
  assert.ok(expandedHtml.includes('role="tooltip"'));
  assert.ok(expandedHtml.includes('Turn 2'));
  assert.ok(expandedHtml.includes('...'));
});

test('ChatThreadJumpRail renders nothing when there are no user prompts', () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatThreadJumpRail, {
      turns: [],
      activeTurnId: null,
      onJumpToTurn: () => {},
    })
  );
  assert.equal(html, '');
});

import { closeDom, domWindow, textOf, typeInto } from './support/domEnv.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import {
  CODING_STARTER_CATEGORIES,
  CODING_STARTERS,
  filterCodingStarters,
} from '../src/lib/codingStarters.ts';
import type { ChatSession, LocalRuntimeConfig } from '../src/types/vault.ts';

after(async () => {
  await closeDom();
});

test('codingStarters covers all categories with unique IDs and accurate filtering', () => {
  const ids = new Set(CODING_STARTERS.map((s) => s.id));
  assert.equal(ids.size, CODING_STARTERS.length);
  assert.ok(CODING_STARTERS.length >= 20, 'should provide a broad range of modern coding tasks');

  for (const cat of CODING_STARTER_CATEGORIES) {
    if (cat.id === 'all') continue;
    const items = filterCodingStarters(cat.id, '');
    assert.ok(items.length >= 2, `category ${cat.id} should have multiple choices`);
    if (cat.id === 'testing') {
      assert.equal(items.length, 18, 'Testing & Debug category should have exactly 18 templates');
    }
  }

  const dockerMatches = filterCodingStarters('all', 'docker ci');
  assert.ok(dockerMatches.some((s) => s.id === 'docker-cicd-pipeline'));

  const scoped = filterCodingStarters('data', 'migration');
  assert.deepEqual(
    scoped.map((s) => s.id),
    ['zero-downtime-migration']
  );

  assert.equal(filterCodingStarters('frontend', 'postgres').length, 0);
});

test('New Coding Session renders filterable coding task starters and loads selected prompt into composer', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ available: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  const container = domWindow.document.createElement('div') as unknown as HTMLElement;
  domWindow.document.body.appendChild(container as never);
  const root: Root = createRoot(container);

  const session: ChatSession = {
    id: 'session-new',
    projectId: 'default-project',
    title: 'New Coding Session',
    messages: [
      {
        id: 'welcome-1',
        role: 'assistant',
        content: 'New local coding session started. Attach any snippet or doc, or ask a question below.',
        createdAt: Date.now(),
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const runtimeConfig: LocalRuntimeConfig = {
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    selectedModel: 'gemma4:e2b',
    temperature: 0.2,
    maxTokens: 1024,
    contextTokens: 4096,
    reasoning: 'off',
    systemPrompt: 'You are a concise coding assistant.',
  };

  const renderPane = async (curSession: ChatSession) => {
    await act(async () => {
      root.render(
        React.createElement(
          ConfirmProvider,
          null,
          React.createElement(GemmaAssistantPane, {
            sessions: [curSession],
            activeSessionId: curSession.id,
            onSelectSession: () => {},
            onCreateSession: () => {},
            onUpdateSession: () => {},
            onDeleteSession: async () => {},
            snippets: [],
            docs: [],
            runtimeConfig,
            probe: {
              connected: false,
              transport: 'none',
              models: [],
              recommendedModel: null,
              error: 'offline',
            },
            probing: false,
            onRescanRuntime: async () => {},
            onOpenRuntimeModal: () => {},
            onSaveSnippetFromCode: async () => {},
            onSaveGeneratedSnippets: async () => [],
            onClearQueuedPrompt: () => {},
          })
        )
      );
    });
  };

  try {
    await renderPane(session);

    const startersRegion = container.querySelector(
      'section[aria-label="Coding task starters"]'
    ) as HTMLElement | null;
    assert.ok(startersRegion, 'coding starters section renders in a new coding session');
    assert.ok(textOf(startersRegion).includes(`${CODING_STARTERS.length} of ${CODING_STARTERS.length} templates`));

    // Filter by category tab
    const testingBtn = [...startersRegion.querySelectorAll('button')].find(
      (b) => textOf(b) === 'Testing & Debug'
    ) as HTMLButtonElement | undefined;
    assert.ok(testingBtn);
    await act(async () => testingBtn.click());
    assert.equal(testingBtn.getAttribute('aria-pressed'), 'true');
    assert.ok(textOf(startersRegion).includes('Playwright E2E Test Spec'));
    assert.ok(!textOf(startersRegion).includes('Rust Error Handling'));

    // Reset to All Tasks and search by keyword
    const allBtn = [...startersRegion.querySelectorAll('button')].find(
      (b) => textOf(b) === 'All Tasks'
    ) as HTMLButtonElement | undefined;
    assert.ok(allBtn);
    await act(async () => allBtn.click());

    const filterInput = startersRegion.querySelector(
      'input[aria-label="Filter coding starter tasks"]'
    ) as HTMLInputElement | null;
    assert.ok(filterInput);
    await act(async () => typeInto(filterInput, 'postman'));
    assert.ok(textOf(startersRegion).includes('Postman API Automation'));
    assert.ok(textOf(startersRegion).includes(`1 of ${CODING_STARTERS.length} templates`));

    // Unmatched query shows empty state + reset button
    await act(async () => typeInto(filterInput, 'zzzz-no-match'));
    const resetBtn = [...startersRegion.querySelectorAll('button')].find(
      (b) => textOf(b) === 'Reset filters'
    ) as HTMLButtonElement | undefined;
    assert.ok(resetBtn);
    await act(async () => resetBtn.click());
    assert.ok(textOf(startersRegion).includes(`${CODING_STARTERS.length} of ${CODING_STARTERS.length} templates`));

    // Selecting a starter fills and focuses the composer textarea
    const starterBtn = [...startersRegion.querySelectorAll('button')].find((b) =>
      textOf(b).includes('Multi-Stage Docker & CI/CD')
    ) as HTMLButtonElement | undefined;
    assert.ok(starterBtn);
    await act(async () => starterBtn.click());

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea.value.includes('multi-stage Dockerfile'));
    assert.equal(domWindow.document.activeElement, textarea as unknown);

    // Once the session has user conversation turns, starter cards disappear
    await renderPane({
      ...session,
      messages: [
        ...session.messages,
        { id: 'u1', role: 'user', content: 'Hello', createdAt: Date.now() },
      ],
    });
    assert.equal(container.querySelector('section[aria-label="Coding task starters"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  }
});

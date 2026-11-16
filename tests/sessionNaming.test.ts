import { closeDom, domWindow, pressKey, textOf, typeInto } from './support/domEnv.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import { CODING_STARTERS } from '../src/lib/codingStarters.ts';
import {
  deriveSessionTitle,
  isDefaultSessionTitle,
  nextDefaultSessionTitle,
} from '../src/lib/sessionNaming.ts';
import type { ChatSession, LocalRuntimeConfig } from '../src/types/vault.ts';

after(async () => {
  await closeDom();
});

test('nextDefaultSessionTitle numbers additional new sessions without duplicates', () => {
  assert.equal(nextDefaultSessionTitle([]), 'New Coding Session');
  assert.equal(
    nextDefaultSessionTitle([{ title: 'New Coding Session' }]),
    'New Coding Session 2'
  );
  assert.equal(
    nextDefaultSessionTitle([
      { title: 'new coding session' },
      { title: 'New Coding Session 2' },
      { title: 'Auth Refactor' },
    ]),
    'New Coding Session 3'
  );
});

test('isDefaultSessionTitle distinguishes default names from user titles', () => {
  assert.equal(isDefaultSessionTitle('New Coding Session'), true);
  assert.equal(isDefaultSessionTitle('New Coding Session 4'), true);
  assert.equal(isDefaultSessionTitle('Gemma Local Coding Session'), true);
  assert.equal(isDefaultSessionTitle('  '), true);
  assert.equal(isDefaultSessionTitle('Explain: Playwright Test'), false);
  assert.equal(isDefaultSessionTitle('Payment Retry Queue'), false);
});

test('deriveSessionTitle generates concise, word-safe titles for starters, snippet actions, and freeform prompts', () => {
  const playwrightStarter = CODING_STARTERS.find((s) => s.id === 'playwright-e2e-spec')!;
  assert.equal(
    deriveSessionTitle({ prompt: playwrightStarter.prompt }),
    'Playwright E2E Test Spec'
  );

  // Snippet quick-action boilerplate pairs verb with clean attachment name
  assert.equal(
    deriveSessionTitle({
      prompt: 'Explain how this snippet works step-by-step, highlighting edge cases.',
      attachments: [
        {
          kind: 'snippet',
          id: 'sn-1',
          title: 'v4 Refactor · Playwright Test Suite',
        },
      ],
      actionKind: 'explain',
    }),
    'Explain: Playwright Test Suite'
  );

  // Freeform prompt strips filler and clamps cleanly on word boundary
  const freeTitle = deriveSessionTitle({
    prompt: 'Please help me optimize database connection pooling for high concurrency workloads in PostgreSQL.',
  });
  assert.ok(freeTitle.length <= 46);
  assert.ok(!freeTitle.startsWith('Please'));
  assert.ok(!freeTitle.endsWith('for…'));
  assert.ok(freeTitle.startsWith('Optimize database connection pooling'));
});

test('GemmaAssistantPane supports inline session rename and locks custom name against auto-naming', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/workspace/status')) {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        message: { role: 'assistant', content: 'Done.' },
        done: true,
        done_reason: 'stop',
      }),
      { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
    );
  }) as typeof fetch;

  const container = domWindow.document.createElement('div') as unknown as HTMLElement;
  domWindow.document.body.appendChild(container as never);
  const root: Root = createRoot(container);

  const initial: ChatSession = {
    id: 'session-rename-test',
    projectId: 'p',
    title: 'New Coding Session 2',
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: 'New local coding session started.',
        createdAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };

  const config: LocalRuntimeConfig = {
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    selectedModel: 'gemma4:e2b',
    temperature: 0.2,
    maxTokens: 512,
    contextTokens: 4096,
    reasoning: 'off',
    systemPrompt: 'You are a helpful coding assistant.',
  };

  let latestSession: ChatSession = initial;

  const Harness: React.FC = () => {
    const [sessions, setSessions] = useState<ChatSession[]>([initial]);
    latestSession = sessions[0];
    return React.createElement(
      ConfirmProvider,
      null,
      React.createElement(GemmaAssistantPane, {
        sessions,
        activeSessionId: initial.id,
        onSelectSession: () => {},
        onCreateSession: () => {},
        onUpdateSession: async (s: ChatSession) => {
          latestSession = s;
          setSessions([s]);
        },
        onDeleteSession: async () => {},
        snippets: [],
        docs: [],
        runtimeConfig: config,
        probe: { connected: true, transport: 'direct', models: [], recommendedModel: null },
        probing: false,
        onRescanRuntime: async () => {},
        onOpenRuntimeModal: () => {},
        onSaveSnippetFromCode: async () => {},
        onSaveGeneratedSnippets: async () => [],
        onClearQueuedPrompt: () => {},
      })
    );
  };

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    // Session select and rename button render even for a single session
    const selectEl = container.querySelector('select[aria-label="Select chat session"]');
    assert.ok(selectEl);
    assert.ok(textOf(selectEl).includes('New Coding Session 2'));

    const renameBtn = container.querySelector(
      'button[aria-label="Rename current chat"]'
    ) as HTMLButtonElement | null;
    assert.ok(renameBtn);
    assert.equal(renameBtn.parentElement, selectEl.parentElement, 'rename trigger sits inside dropdown boundary');
    await act(async () => renameBtn.click());

    const renameInput = container.querySelector(
      'input[aria-label="Rename chat session"]'
    ) as HTMLInputElement | null;
    assert.ok(renameInput);

    // Escape cancels rename without changing title
    await act(async () => typeInto(renameInput, 'Should Cancel'));
    await act(async () => pressKey(renameInput, 'Escape'));
    assert.equal(latestSession.title, 'New Coding Session 2');

    // Re-open, rename, and save with Enter
    const renameBtnAgain = container.querySelector(
      'button[aria-label="Rename current chat"]'
    ) as HTMLButtonElement;
    await act(async () => renameBtnAgain.click());
    const renameInput2 = container.querySelector(
      'input[aria-label="Rename chat session"]'
    ) as HTMLInputElement;
    await act(async () => typeInto(renameInput2, 'Redis Rate Limiter'));
    await act(async () => pressKey(renameInput2, 'Enter'));

    assert.equal(latestSession.title, 'Redis Rate Limiter');
    assert.equal(latestSession.titleLocked, true);

    // Sending first prompt respects locked custom name
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => typeInto(textarea, 'Write a Python script for token buckets'));
    const sendBtn = container.querySelector(
      'button[aria-label="Send prompt to local Gemma"]'
    ) as HTMLButtonElement;
    await act(async () => sendBtn.click());

    assert.equal(latestSession.title, 'Redis Rate Limiter');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
  }
});

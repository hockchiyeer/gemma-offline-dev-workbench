import { closeDom, domWindow, pressKey, textOf, typeInto } from './support/domEnv.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createApp } from '../server.ts';
import { createWorkspaceManager } from '../server/workspace/workspace.ts';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import type { ChatMessage, ChatSession, CodeSnippet, LocalRuntimeConfig } from '../src/types/vault.ts';
import { cleanupProjects, makeProject } from './support/workspaceFixture.ts';

// ---- infrastructure: the real GemmaVault server, plus a fake Ollama that records what it is sent ----
interface ChatCall {
  messages: Array<{ role: string; content: string }>;
  options?: Record<string, unknown>;
}

let appServer: http.Server;
let appBase = '';
let ollamaServer: http.Server;
let ollamaBase = '';
const chatCalls: ChatCall[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  appServer = http.createServer(createApp({ workspaceManager: createWorkspaceManager(), allowWorkspace: true }));
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r));
  appBase = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;

  ollamaServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/chat') {
        chatCalls.push(JSON.parse(body) as ChatCall);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: 'The retry loop backs off exponentially.' },
            done: false,
          }) +
            '\n' +
            JSON.stringify({
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 10,
              eval_count: 5,
            }) +
            '\n'
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => ollamaServer.listen(0, '127.0.0.1', r));
  ollamaBase = `http://127.0.0.1:${(ollamaServer.address() as { port: number }).port}`;

  // The app calls relative URLs; point them at the test server.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return realFetch(url.startsWith('/') ? `${appBase}${url}` : url, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => ollamaServer.close(() => r()));
  await cleanupProjects();
  await closeDom();
});

// ---- harness ----
const SYSTEM_PROMPT = 'You are a careful local coding assistant.';
const noop = () => {};
const baseSession = (over: Partial<ChatSession> = {}): ChatSession => ({
  id: 'chat-1',
  projectId: 'p',
  title: 'Billing chat',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  ...over,
});
const snippet = (): CodeSnippet => ({
  id: 'sn1',
  projectId: 'p',
  title: 'Retry helper',
  language: 'typescript',
  code: 'export const retry = 1;',
  notes: '',
  tags: [],
  favorite: false,
  createdAt: 1,
  updatedAt: 1,
});

interface Mounted {
  container: HTMLElement;
  sessions: () => ChatSession[];
  unmount: () => Promise<void>;
}

async function mount(initial: ChatSession): Promise<Mounted> {
  let latest: ChatSession[] = [initial];
  const config: LocalRuntimeConfig = {
    kind: 'ollama',
    baseUrl: ollamaBase,
    selectedModel: 'gemma4:e4b',
    temperature: 0.2,
    maxTokens: 512,
    contextTokens: 16384,
    reasoning: 'off',
    systemPrompt: SYSTEM_PROMPT,
  };
  const Harness: React.FC = () => {
    const [sessions, setSessions] = useState<ChatSession[]>([initial]);
    latest = sessions;
    return React.createElement(
      ConfirmProvider,
      null,
      React.createElement(GemmaAssistantPane, {
        sessions,
        activeSessionId: 'chat-1',
        onSelectSession: noop,
        onCreateSession: noop,
        onUpdateSession: async (s: ChatSession) => {
          setSessions((prev) => prev.map((x) => (x.id === s.id ? s : x)));
        },
        onDeleteSession: async () => {},
        snippets: [snippet()],
        docs: [],
        runtimeConfig: config,
        probe: { connected: true, transport: 'direct', models: [], recommendedModel: null },
        probing: false,
        onRescanRuntime: async () => {},
        onOpenRuntimeModal: noop,
        onSaveSnippetFromCode: async () => {},
        onSaveGeneratedSnippets: async () => [],
        onClearQueuedPrompt: noop,
      })
    );
  };
  const container = domWindow.document.createElement('div') as unknown as HTMLElement;
  domWindow.document.body.appendChild(container as never);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  return {
    container,
    sessions: () => latest,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

async function settle(ms = 40) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitUntil(cond: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await settle(25);
  }
}

const button = (c: HTMLElement, label: string | RegExp) =>
  [...c.querySelectorAll('button')].find((b) =>
    typeof label === 'string'
      ? textOf(b).includes(label)
      : label.test(textOf(b)) || label.test(b.getAttribute('aria-label') ?? '')
  ) as HTMLButtonElement | undefined;
const textarea = (c: HTMLElement) => c.querySelector('textarea') as HTMLTextAreaElement;

async function openWorkspaceThroughUi(m: Mounted, root: string) {
  await waitUntil(
    () => !!button(m.container, 'Open project folder'),
    'the Open project folder button (server probe)'
  );
  await act(async () => button(m.container, 'Open project folder')!.click());
  const input = m.container.querySelector('input[type="text"][list]') as HTMLInputElement;
  assert.ok(input, 'the folder form is shown');
  await act(async () => typeInto(input, root));
  await act(async () => {
    (m.container.querySelector('form') as HTMLFormElement).dispatchEvent(
      new domWindow.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event
    );
  });
  await waitUntil(() => m.sessions()[0].workspace !== undefined, 'the workspace to be saved on the chat');
  await waitUntil(() => /9 files/.test(textOf(m.container)), 'file count to show');
}

// ---- the end-to-end scenario ----
test('open a folder, @-mention a file, ask a question: the model receives the file, search hits, outline and notes (and nothing else changes)', async () => {
  chatCalls.length = 0;
  const root = await makeProject();
  const m = await mount(baseSession());
  try {
    assert.equal(m.sessions()[0].workspace, undefined);
    await openWorkspaceThroughUi(m, root);
    const ws = m.sessions()[0].workspace!;
    assert.equal(ws.path, root, 'the canonical path is stored');
    assert.deepEqual([ws.repoMap, ws.autoRetrieve], [true, true]);
    assert.ok(textOf(m.container).includes('9 files'));
    assert.ok(button(m.container, 'Preview'));

    // Type "@pay": a popup offers the file once the (debounced) search returns.
    const ta = textarea(m.container);
    await act(async () => typeInto(ta, 'Explain @pay', 12));
    await waitUntil(
      () => !!m.container.querySelector('[role="listbox"] [role="option"]'),
      'mention suggestions'
    );
    const options = [...m.container.querySelectorAll('[role="option"]')].map((o) => textOf(o));
    assert.ok(options[0].includes('src/payments.ts'), options.join(' | '));
    assert.equal(ta.getAttribute('aria-expanded'), 'true');

    // Pick it with the keyboard.
    await act(async () => pressKey(ta, 'Enter'));
    assert.equal(textarea(m.container).value, 'Explain', 'the @token is replaced by an attachment chip');
    assert.ok(/Context:.*src\/payments\.ts/.test(textOf(m.container)));
    assert.equal(m.container.querySelector('[role="listbox"]'), null);

    // Ask the question.
    await act(async () => typeInto(textarea(m.container), 'Explain how failed payments are retried'));
    await act(async () => button(m.container, /Send prompt/)!.click());

    await waitUntil(() => chatCalls.length === 1, 'the chat request to reach the model');
    await waitUntil(
      () => m.sessions()[0].messages.some((x) => x.role === 'assistant' && x.content.includes('backs off')),
      'the reply to be stored'
    );

    const call = chatCalls[0];
    assert.equal(call.messages[0].role, 'system');
    assert.equal(call.messages[0].content, SYSTEM_PROMPT, 'the system prompt is untouched (keeps the runtime cache warm)');
    const user = call.messages[call.messages.length - 1];
    assert.equal(user.role, 'user');
    assert.ok(user.content.endsWith('--- REQUEST ---\nExplain how failed payments are retried'));
    assert.ok(user.content.includes('--- INSTRUCTIONS: Workspace notes ---'));
    assert.ok(user.content.includes('--- FILE: src/payments.ts ---\n```typescript\n'), 'the mentioned file, fenced');
    assert.ok(user.content.includes('export async function retryFailedPayment'));
    assert.ok(user.content.includes('--- RETRIEVED: src/invoice.ts:'), 'auto-search added related code');
    assert.ok(!user.content.includes('--- RETRIEVED: src/payments.ts'), 'but did not repeat the file already attached');
    assert.ok(user.content.includes('--- REPO MAP:'), 'and the project outline');
    assert.ok(!/SUPER_SECRET|secret_gateway|PRIVATE KEY/.test(user.content), 'secrets never reach the model');
    assert.ok(user.content.indexOf('--- FILE:') < user.content.indexOf('--- RETRIEVED:'));
    assert.ok(user.content.indexOf('--- RETRIEVED:') < user.content.indexOf('--- REPO MAP:'));

    // The stored message records what was added, and the transcript shows it.
    const stored = m.sessions()[0].messages.find((x) => x.role === 'user') as ChatMessage;
    assert.ok(stored.sentContext?.includes('src/payments.ts'));
    assert.equal(stored.workspaceContext?.workspaceName, root.split(/[\\/]/).pop());
    assert.deepEqual(
      [...new Set(stored.workspaceContext!.items.map((i) => i.via))].sort(),
      ['map', 'mention', 'retrieved']
    );
    assert.equal(stored.content, 'Explain how failed payments are retried', 'the visible message is just what the user typed');
    assert.deepEqual(stored.attachments, [{ kind: 'file', id: 'src/payments.ts', title: 'src/payments.ts' }]);
    await waitUntil(
      () => /Project context added:.*mentioned.*found by search.*project outline/.test(textOf(m.container)),
      'the disclosure under the message'
    );

    // A follow-up reuses the exact earlier text (prompt-cache friendly) and adds fresh context.
    await act(async () => typeInto(textarea(m.container), 'And what about refunds?'));
    await act(async () => button(m.container, /Send prompt/)!.click());
    await waitUntil(() => chatCalls.length === 2, 'the follow-up request');
    const second = chatCalls[1].messages;
    assert.deepEqual(
      second.slice(0, chatCalls[0].messages.length),
      chatCalls[0].messages,
      'the first request is an exact prefix of the second'
    );
    assert.ok(second[second.length - 1].content.includes('refunds'));
  } finally {
    await m.unmount();
  }
});

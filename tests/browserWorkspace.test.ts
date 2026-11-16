import { closeDom, domWindow, pressKey, textOf, typeInto } from './support/domEnv.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmProvider } from '../src/components/ConfirmDialog.tsx';
import { GemmaAssistantPane } from '../src/components/GemmaAssistantPane.tsx';
import {
  BrowserWorkspaceConnection,
  clearBrowserWorkspaceCache,
  isCrossOriginSubframe,
  registerBrowserDirectoryHandle,
  registerBrowserFileSnapshot,
  requestBrowserWorkspaceAccess,
  type BrowserDirHandle,
  type BrowserFileHandle,
  type BrowserPermissionState,
} from '../src/lib/browserWorkspace.ts';
import { WorkspaceError } from '../src/lib/workspaceCore.ts';
import type { ChatSession, LocalRuntimeConfig } from '../src/types/vault.ts';

type TreeSpec = {
  [name: string]: string | Uint8Array | TreeSpec;
};

function makeFakeDirHandle(
  name: string,
  spec: TreeSpec,
  permRef?: { state: BrowserPermissionState }
): BrowserDirHandle {
  const children = new Map<string, BrowserDirHandle | BrowserFileHandle>();

  for (const [entryName, value] of Object.entries(spec)) {
    if (typeof value === 'string' || value instanceof Uint8Array) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      const fh: BrowserFileHandle = {
        kind: 'file',
        name: entryName,
        getFile: async () =>
          ({
            name: entryName,
            size: bytes.byteLength,
            lastModified: 1_700_000_000_000,
            text: async () => new TextDecoder('utf-8').decode(bytes),
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          }) as unknown as File,
      };
      children.set(entryName, fh);
    } else {
      children.set(entryName, makeFakeDirHandle(entryName, value));
    }
  }

  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const pair of children.entries()) yield pair;
    },
    async getFileHandle(childName: string) {
      const hit = children.get(childName);
      if (!hit || hit.kind !== 'file') throw new Error(`NotFoundError: ${childName}`);
      return hit;
    },
    async getDirectoryHandle(childName: string) {
      const hit = children.get(childName);
      if (!hit || hit.kind !== 'directory') throw new Error(`NotFoundError: ${childName}`);
      return hit;
    },
    async queryPermission() {
      return permRef?.state ?? 'granted';
    },
    async requestPermission() {
      if (permRef) permRef.state = 'granted';
      return permRef?.state ?? 'granted';
    },
  };
}

let ollamaServer: http.Server;
let ollamaBase = '';
const chatCalls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const realFetch = globalThis.fetch;

before(async () => {
  ollamaServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/embed') {
        const parsed = JSON.parse(body) as { input: string[] };
        const embeddings = parsed.input.map((t) =>
          t.includes('refund') || t.includes('Refund') ? [0.95, 0.05] : [0.1, 0.99]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings }));
        return;
      }
      if (req.url === '/api/chat') {
        chatCalls.push(JSON.parse(body) as { messages: Array<{ role: string; content: string }> });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(
          JSON.stringify({ message: { role: 'assistant', content: 'Handled via browser folder.' }, done: false }) +
            '\n' +
            JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) +
            '\n'
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => ollamaServer.listen(0, '127.0.0.1', r));
  ollamaBase = `http://127.0.0.1:${(ollamaServer.address() as { port: number }).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  clearBrowserWorkspaceCache();
  await new Promise<void>((r) => ollamaServer.close(() => r()));
  await closeDom();
});

test('BrowserWorkspaceConnection scans safely, redacts secrets, searches lexically + semantically, and handles permissions', async () => {
  clearBrowserWorkspaceCache();
  const perm = { state: 'prompt' as BrowserPermissionState };
  const dir = makeFakeDirHandle(
    'pwa-repo',
    {
      '.gitignore': 'ignored-out/\n*.log\n',
      '.env': 'SECRET=do_not_expose_123456',
      '.git': { HEAD: 'ref: refs/heads/main\n' },
      'ignored-out': { 'bundle.js': 'console.log(1);' },
      src: {
        'payments.ts':
          'const api_key = "browser_secret_token_987654";\nexport function retryBrowserPayment(n: number) { return n; }\n',
        'refunds.ts': 'export function issueRefund(id: string) { return id; }\n',
        'logo.bin': new Uint8Array([0, 1, 2, 3, 0]),
      },
      'README.md': '# PWA Repo\n',
    },
    perm
  );

  const key = await registerBrowserDirectoryHandle(dir);
  const conn = new BrowserWorkspaceConnection(key, { baseUrl: ollamaBase, model: 'embeddinggemma' }, realFetch);

  // When permission is still 'prompt', open() reports permission needed rather than throwing an unhandled crash.
  await assert.rejects(() => conn.open(), (err: unknown) => err instanceof WorkspaceError && err.status === 403);

  // User clicks Grant access -> requestPermission grants read access and open() indexes cleanly.
  await requestBrowserWorkspaceAccess(key);
  const info = await conn.open();
  assert.equal(info.source, 'browser');
  assert.equal(info.name, 'pwa-repo');
  assert.equal(info.fileCount, 5); // .gitignore, payments.ts, refunds.ts, logo.bin (listed, not indexed), README.md
  assert.equal(info.isGit, false);

  // Wait briefly for background embeddings batch.
  for (let i = 0; i < 20; i++) {
    const cur = await conn.info();
    if (cur.embeddings.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }

  // Path safety and secret redaction.
  await assert.rejects(() => conn.read('../etc/passwd'), WorkspaceError);
  await assert.rejects(() => conn.read('.env'), WorkspaceError);
  await assert.rejects(() => conn.read('src/logo.bin'), WorkspaceError);
  const pay = await conn.read('src/payments.ts');
  assert.equal(pay.redactions, 1);
  assert.ok(!pay.content.includes('browser_secret_token_987654'));
  assert.ok(pay.content.includes('[REDACTED]'));

  // Search, symbols, tree, repo map, and git fallback error.
  assert.equal((await conn.symbols('retryBrowserPayment', 4))[0].name, 'retryBrowserPayment');
  assert.ok((await conn.tree('', 2)).some((e) => e.path === 'src' && e.type === 'dir'));
  const search = await conn.search('issue a refund', 'hybrid', 4);
  assert.equal(search.mode, 'hybrid');
  assert.ok(search.hits.some((h) => h.path === 'src/refunds.ts'));
  assert.ok((await conn.repoMap(500, ['src/payments.ts'])).text.includes('src/payments.ts'));
  await assert.rejects(() => conn.git('status'), (err: unknown) => err instanceof WorkspaceError && err.status === 501);

  await conn.close();
});

test('GemmaAssistantPane uses File System Access API fallback when server /api/workspace/status reports unavailable', async () => {
  clearBrowserWorkspaceCache();
  chatCalls.length = 0;

  const dir = makeFakeDirHandle('standalone-app', {
    src: {
      'billing.ts': 'export function calculateInvoiceTotal(cents: number) { return cents; }\n',
    },
    'README.md': '# Standalone App\n',
  });

  // Expose Chromium showDirectoryPicker on domWindow while server workspace status is unavailable.
  (domWindow as unknown as { showDirectoryPicker?: () => Promise<BrowserDirHandle> }).showDirectoryPicker = async () =>
    dir;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/workspace/status') {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url.startsWith('/') ? `${ollamaBase}${url}` : url, init);
  }) as typeof fetch;

  const initial: ChatSession = {
    id: 'chat-browser-1',
    projectId: 'p',
    title: 'Browser Workspace Chat',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
  let latest: ChatSession[] = [initial];

  const config: LocalRuntimeConfig = {
    kind: 'ollama',
    baseUrl: ollamaBase,
    selectedModel: 'gemma4:e4b',
    temperature: 0.2,
    maxTokens: 512,
    contextTokens: 16384,
    reasoning: 'off',
    systemPrompt: 'You are a helpful coding assistant.',
  };

  const Harness: React.FC = () => {
    const [sessions, setSessions] = useState<ChatSession[]>([initial]);
    latest = sessions;
    return React.createElement(
      ConfirmProvider,
      null,
      React.createElement(GemmaAssistantPane, {
        sessions,
        activeSessionId: 'chat-browser-1',
        onSelectSession: () => {},
        onCreateSession: () => {},
        onUpdateSession: async (s: ChatSession) => setSessions((prev) => prev.map((x) => (x.id === s.id ? s : x))),
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

  const container = domWindow.document.createElement('div') as unknown as HTMLElement;
  domWindow.document.body.appendChild(container as never);
  const root: Root = createRoot(container);

  try {
    await act(async () => root.render(React.createElement(Harness)));
    const findBtn = (txt: string) =>
      [...container.querySelectorAll('button')].find((b) => textOf(b).includes(txt)) as HTMLButtonElement | undefined;

    for (let i = 0; i < 40 && !findBtn('Open project folder'); i++) {
      await act(async () => new Promise((r) => setTimeout(r, 25)));
    }
    const openBtn = findBtn('Open project folder');
    assert.ok(openBtn, 'Open project folder should appear when showDirectoryPicker is available');

    await act(async () => openBtn.click());
    for (let i = 0; i < 40 && !textOf(container).includes('standalone-app'); i++) {
      await act(async () => new Promise((r) => setTimeout(r, 25)));
    }
    assert.ok(textOf(container).includes('standalone-app'));
    assert.ok(textOf(container).includes('Browser folder'));
    assert.equal(latest[0].workspace?.name, 'standalone-app');

    // Type @bill -> @-mention resolves from BrowserWorkspaceConnection.
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => typeInto(ta, 'Review @bill', 12));
    for (let i = 0; i < 40 && !container.querySelector('[role="listbox"] [role="option"]'); i++) {
      await act(async () => new Promise((r) => setTimeout(r, 25)));
    }
    const options = [...container.querySelectorAll('[role="option"]')].map((o) => textOf(o));
    assert.ok(options[0].includes('src/billing.ts'), options.join(' | '));
    await act(async () => pressKey(ta, 'Enter'));

    await act(async () => typeInto(container.querySelector('textarea') as HTMLTextAreaElement, 'Check billing total'));
    await act(async () => findBtn('Send prompt') ?? [...container.querySelectorAll('button')].find((b) => /Send prompt/.test(b.getAttribute('aria-label') ?? ''))!.click());

    for (let i = 0; i < 40 && chatCalls.length === 0; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 25)));
    }
    assert.equal(chatCalls.length, 1);
    const userMsg = chatCalls[0].messages[chatCalls[0].messages.length - 1].content;
    assert.ok(userMsg.includes('--- FILE: src/billing.ts ---'));
    assert.ok(userMsg.includes('calculateInvoiceTotal'));
  } finally {
    delete (domWindow as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    await act(async () => root.unmount());
  }
});

function makeSnapshotFile(relPath: string, content: string | Uint8Array): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    name: relPath.split('/').pop() || relPath,
    webkitRelativePath: relPath,
    size: bytes.byteLength,
    lastModified: 1_700_000_000_000,
    text: async () => new TextDecoder('utf-8').decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

test('webkitdirectory snapshot fallback works cleanly inside cross-origin iframes without calling showDirectoryPicker', async () => {
  clearBrowserWorkspaceCache();
  chatCalls.length = 0;

  // Snapshot engine filters .git, node_modules, .gitignore, .env, binary files, and redacts secrets.
  const snapFiles = [
    makeSnapshotFile('iframe-repo/.gitignore', 'ignored-dist/\n'),
    makeSnapshotFile('iframe-repo/.env', 'SECRET=top_secret_never_read'),
    makeSnapshotFile('iframe-repo/.git/HEAD', 'ref: refs/heads/main\n'),
    makeSnapshotFile('iframe-repo/ignored-dist/app.js', 'console.log("ignored");'),
    makeSnapshotFile('iframe-repo/src/invoice.ts', 'const api_key = "iframe_secret_token_4455";\nexport function generateInvoice(n: number) { return n; }\n'),
    makeSnapshotFile('iframe-repo/src/icon.bin', new Uint8Array([0, 1, 2, 0])),
  ];

  const picked = registerBrowserFileSnapshot(snapFiles);
  assert.equal(picked.name, 'iframe-repo');
  const snapConn = new BrowserWorkspaceConnection(picked.root);
  const info = await snapConn.open();
  assert.equal(info.source, 'browser');
  assert.equal(info.fileCount, 3); // .gitignore, src/invoice.ts, src/icon.bin (listed only)
  const readInv = await snapConn.read('src/invoice.ts');
  assert.equal(readInv.redactions, 1);
  assert.ok(!readInv.content.includes('iframe_secret_token_4455'));
  await assert.rejects(() => snapConn.read('.env'), WorkspaceError);
  await snapConn.close();

  // Simulate cross-origin iframe where accessing top.location throws SecurityError,
  // and the browser supports <input type="file" webkitdirectory>.
  const origTopDesc = Object.getOwnPropertyDescriptor(domWindow, 'top');
  const origWebkitDirDesc = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'webkitdirectory');
  Object.defineProperty(domWindow.HTMLInputElement.prototype, 'webkitdirectory', {
    configurable: true,
    writable: true,
    value: false,
  });
  let pickerCalled = false;
  (domWindow as unknown as { showDirectoryPicker?: () => Promise<BrowserDirHandle> }).showDirectoryPicker = async () => {
    pickerCalled = true;
    throw new DOMException("Failed to execute 'showDirectoryPicker' on 'Window': Cross origin sub frames aren't allowed to show a file picker.", 'SecurityError');
  };
  Object.defineProperty(domWindow, 'top', {
    configurable: true,
    get() {
      return {
        get location() {
          throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
        },
      };
    },
  });

  assert.equal(isCrossOriginSubframe(), true);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/workspace/status') {
      return new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url.startsWith('/') ? `${ollamaBase}${url}` : url, init);
  }) as typeof fetch;

  const initial: ChatSession = {
    id: 'chat-iframe-1',
    projectId: 'p',
    title: 'Iframe Chat',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
  let latest: ChatSession[] = [initial];

  const config: LocalRuntimeConfig = {
    kind: 'ollama',
    baseUrl: ollamaBase,
    selectedModel: 'gemma4:e4b',
    temperature: 0.2,
    maxTokens: 512,
    contextTokens: 16384,
    reasoning: 'off',
    systemPrompt: 'You are a helpful coding assistant.',
  };

  const Harness: React.FC = () => {
    const [sessions, setSessions] = useState<ChatSession[]>([initial]);
    latest = sessions;
    return React.createElement(
      ConfirmProvider,
      null,
      React.createElement(GemmaAssistantPane, {
        sessions,
        activeSessionId: 'chat-iframe-1',
        onSelectSession: () => {},
        onCreateSession: () => {},
        onUpdateSession: async (s: ChatSession) => setSessions((prev) => prev.map((x) => (x.id === s.id ? s : x))),
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

  const container = domWindow.document.createElement('div') as unknown as HTMLElement;
  domWindow.document.body.appendChild(container as never);
  const root: Root = createRoot(container);

  try {
    await act(async () => root.render(React.createElement(Harness)));
    const findBtn = (txt: string) =>
      [...container.querySelectorAll('button')].find((b) => textOf(b).includes(txt)) as HTMLButtonElement | undefined;

    for (let i = 0; i < 40 && !findBtn('Open project folder'); i++) {
      await act(async () => new Promise((r) => setTimeout(r, 25)));
    }
    const dirInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    assert.ok(dirInput, 'hidden webkitdirectory input should be rendered');
    let inputClicked = false;
    dirInput.click = () => {
      inputClicked = true;
    };

    await act(async () => findBtn('Open project folder')!.click());
    assert.equal(pickerCalled, false, 'must NOT call blocked showDirectoryPicker inside cross-origin iframe');
    assert.equal(inputClicked, true, 'should trigger webkitdirectory input instead');

    Object.defineProperty(dirInput, 'files', {
      configurable: true,
      value: snapFiles,
    });
    await act(async () => {
      dirInput.dispatchEvent(new domWindow.Event('change', { bubbles: true }) as unknown as Event);
    });

    for (let i = 0; i < 40 && !textOf(container).includes('iframe-repo'); i++) {
      await act(async () => new Promise((r) => setTimeout(r, 25)));
    }
    assert.ok(textOf(container).includes('iframe-repo'));
    assert.ok(textOf(container).includes('Browser folder'));
    assert.equal(latest[0].workspace?.name, 'iframe-repo');
  } finally {
    delete (domWindow as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    if (origTopDesc) Object.defineProperty(domWindow, 'top', origTopDesc);
    if (origWebkitDirDesc) {
      Object.defineProperty(domWindow.HTMLInputElement.prototype, 'webkitdirectory', origWebkitDirDesc);
    } else {
      delete (domWindow.HTMLInputElement.prototype as unknown as { webkitdirectory?: unknown }).webkitdirectory;
    }
    await act(async () => root.unmount());
  }
});

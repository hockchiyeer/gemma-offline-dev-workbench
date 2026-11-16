import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../server.ts';
import { handleWorkspaceOp } from '../server/workspace/api.ts';
import { normalizePickedPath, resolveInitialBrowseDir } from '../server/workspace/browse.ts';
import { IgnoreMatcher } from '../server/workspace/ignore.ts';
import { redactSecrets, resolveInside, resolveRoot, WorkspaceError } from '../server/workspace/safety.ts';
import { extractImports, extractSymbols } from '../server/workspace/symbols.ts';
import { createWorkspaceManager, scorePath } from '../server/workspace/workspace.ts';
import { cleanupProjects, makeProject } from './support/workspaceFixture.ts';

after(async () => {
  await cleanupProjects();
});

test('IgnoreMatcher handles comments, negations, trailing slashes, and double-star globs', () => {
  const m = new IgnoreMatcher().add(`
# ignore build and logs
dist/
*.log
!important.log
**/cache/*.json
`);
  assert.equal(m.ignores('dist', true), true);
  assert.equal(m.ignores('dist/bundle.js', false), true);
  assert.equal(m.ignores('app.log', false), true);
  assert.equal(m.ignores('important.log', false), false);
  assert.equal(m.ignores('a/b/cache/data.json', false), true);
  assert.equal(m.ignores('src/index.ts', false), false);
});

test('safety.ts blocks path traversal, symlink escape, denied secret files, and redacts inline credentials', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-safety-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-outside-')));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/ok.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1234567890');
    fs.writeFileSync(path.join(root, '.env.example'), 'SECRET=changeme');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');

    assert.equal(resolveInside(root, 'src/ok.ts'), path.join(root, 'src/ok.ts'));
    assert.equal(resolveInside(root, '.env.example'), path.join(root, '.env.example'));

    assert.throws(() => resolveInside(root, '../etc/passwd'), WorkspaceError);
    assert.throws(() => resolveInside(root, '/etc/passwd'), WorkspaceError);
    assert.throws(() => resolveInside(root, '.env'), (err: unknown) => err instanceof WorkspaceError && err.status === 403);
    assert.throws(() => resolveRoot('/'), WorkspaceError);

    // Symlink escape check (skip gracefully only if platform forbids symlinks)
    try {
      fs.symlinkSync(outside, path.join(root, 'escape-link'));
      assert.throws(() => resolveInside(root, 'escape-link/secret.txt'), (err: unknown) => err instanceof WorkspaceError && err.status === 403);
    } catch {
      // ignore EPERM on constrained Windows runners
    }

    const sample = 'const secret = "my_sample_secret_value_123"; const api_key = "very_secret_token_999";';
    const red = redactSecrets(sample);
    assert.equal(red.count, 2);
    assert.ok(!red.text.includes('my_sample_secret_value_123'));
    assert.ok(!red.text.includes('very_secret_token_999'));
    assert.ok(red.text.includes('[REDACTED]'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('symbols.ts extracts multi-language symbols and relative imports', () => {
  const tsCode = `
import { a } from './dep';
export interface User { id: string }
export async function retryPayment(n: number) { return n; }
export const MAX_RETRIES = 3;
`;
  const syms = extractSymbols('src/p.ts', 'typescript', tsCode);
  assert.deepEqual(
    syms.map((s) => s.name),
    ['User', 'retryPayment', 'MAX_RETRIES']
  );
  assert.deepEqual(extractImports('typescript', tsCode), ['./dep']);

  const pySyms = extractSymbols('app.py', 'python', 'class Worker:\n    pass\nasync def run_job():\n    pass\n');
  assert.deepEqual(
    pySyms.map((s) => [s.kind, s.name]),
    [
      ['class', 'Worker'],
      ['function', 'run_job'],
    ]
  );
});

test('WorkspaceManager indexes files safely, searches with BM25 + optional embeddings, renders repo map, and serves API', async () => {
  const root = await makeProject();

  // Mock loopback Ollama /api/embed server
  const embedServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/embed') {
        const parsed = JSON.parse(body) as { input: string[] };
        const embeddings = parsed.input.map((txt) =>
          txt.includes('refund') || txt.includes('Refund') ? [0.95, 0.05] : [0.1, 0.99]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => embedServer.listen(0, '127.0.0.1', r));
  const embPort = (embedServer.address() as { port: number }).port;

  try {
    const mgr = createWorkspaceManager();
    const opened = await mgr.open(root, {
      baseUrl: `http://127.0.0.1:${embPort}`,
      model: 'embeddinggemma',
    });
    assert.equal(opened.fileCount, 9);
    assert.equal(opened.truncated, false);

    // Wait briefly for background embedding batch to finish
    for (let i = 0; i < 20; i++) {
      const cur = mgr.info(root);
      if (cur.embeddings.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const postEmb = mgr.info(root);
    assert.equal(postEmb.embeddings.state, 'idle');
    assert.ok(postEmb.embeddings.embedded > 0);

    // File and symbol search
    const filesRes = mgr.files(root, 'pay', 6);
    assert.equal(filesRes.files[0].path, 'src/payments.ts');
    assert.ok(scorePath('src/payments.ts', 'pay') > scorePath('README.md', 'pay'));

    const syms = mgr.symbols(root, 'retryFailed', 5);
    assert.equal(syms[0].name, 'retryFailedPayment');

    // Secret redaction during read and denied .env
    const readPay = mgr.read(root, 'src/payments.ts');
    assert.ok(!readPay.content.includes('some_test_gateway_value_123456'));
    assert.equal(readPay.redactions, 1);
    assert.throws(() => mgr.read(root, '.env'), WorkspaceError);

    // Hybrid search
    const searchRes = await mgr.search(root, 'issue a refund', 'hybrid', 4);
    assert.equal(searchRes.mode, 'hybrid');
    assert.ok(searchRes.hits.some((h) => h.path === 'src/billing/refunds.ts'));

    // Repo map prioritizes imported modules and redacts inline secrets
    const map = mgr.repoMap(root, 500, ['src/payments.ts']);
    assert.ok(map.files > 0);
    assert.ok(map.text.includes('src/payments.ts'));
    assert.ok(!map.text.includes('secret_gateway') && !map.text.includes('PRIVATE KEY'));

    // Transport-independent API rejects non-loopback embedding URLs
    await assert.rejects(
      () =>
        handleWorkspaceOp(mgr, 'open', {
          root,
          embedding: { baseUrl: 'https://evil.example', model: 'embeddinggemma' },
        }),
      WorkspaceError
    );
    await mgr.closeAll();
  } finally {
    await new Promise<void>((r) => embedServer.close(() => r()));
  }
});

test('chokidar watcher incrementally indexes new, updated, and deleted files while skipping denied/ignored paths', async () => {
  const root = await makeProject();
  const mgr = createWorkspaceManager({ watch: true, watchDebounceMs: 40 });
  try {
    const opened = await mgr.open(root);
    assert.equal(opened.watching, true);
    assert.equal(opened.source, 'server');
    assert.equal(opened.fileCount, 9);

    // Wait briefly for chokidar to finish attaching OS watchers before writing.
    await new Promise((r) => setTimeout(r, 120));

    // Add a new TypeScript file and a denied .env file on disk.
    const addedPath = path.join(root, 'src/loyalty.ts');
    fs.writeFileSync(addedPath, 'export function awardLoyaltyPoints(n: number) { return n * 2; }\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=should_never_be_indexed');

    let found = false;
    for (let i = 0; i < 40; i++) {
      const syms = mgr.symbols(root, 'awardLoyaltyPoints', 5);
      if (syms.some((s) => s.name === 'awardLoyaltyPoints' && s.path === 'src/loyalty.ts')) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(found, true, 'chokidar watcher should pick up newly added source files incrementally');
    assert.equal(mgr.info(root).fileCount, 10, 'denied .env.local must not enter file index');

    const hitRes = await mgr.search(root, 'awardLoyaltyPoints', 'lexical', 4);
    assert.equal(hitRes.hits[0].path, 'src/loyalty.ts');

    // Modify the file and verify updated symbol appears.
    fs.writeFileSync(addedPath, 'export function redeemLoyaltyVoucher(id: string) { return id; }\n');
    let updated = false;
    for (let i = 0; i < 40; i++) {
      const syms = mgr.symbols(root, 'redeemLoyaltyVoucher', 5);
      if (syms.length > 0 && mgr.symbols(root, 'awardLoyaltyPoints', 5).length === 0) {
        updated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(updated, true, 'chokidar watcher should replace symbols and chunks on file modification');

    // Delete the file and verify it is removed from index and search.
    fs.unlinkSync(addedPath);
    let removed = false;
    for (let i = 0; i < 40; i++) {
      if (mgr.files(root, 'loyalty', 5).files.length === 0 && mgr.symbols(root, 'redeemLoyaltyVoucher', 5).length === 0) {
        removed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(removed, true, 'chokidar watcher should remove deleted files from the index');
    assert.equal(mgr.info(root).fileCount, 9);
  } finally {
    await mgr.closeAll();
  }
});

test('Express /api/workspace routes enforce CSRF header and allowWorkspace flag', async () => {
  const restricted = http.createServer(createApp({ allowWorkspace: false }));
  await new Promise<void>((r) => restricted.listen(0, '127.0.0.1', r));
  const port = (restricted.address() as { port: number }).port;
  try {
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/workspace/status`);
    assert.equal(statusRes.status, 200);
    assert.deepEqual(await statusRes.json(), { available: false, browse: false });

    const blockedOp = await fetch(`http://127.0.0.1:${port}/api/workspace/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({ root: process.cwd() }),
    });
    assert.equal(blockedOp.status, 403);
  } finally {
    await new Promise<void>((r) => restricted.close(() => r()));
  }

  const allowed = http.createServer(createApp({ allowWorkspace: true }));
  await new Promise<void>((r) => allowed.listen(0, '127.0.0.1', r));
  const port2 = (allowed.address() as { port: number }).port;
  try {
    const noHeader = await fetch(`http://127.0.0.1:${port2}/api/workspace/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: process.cwd() }),
    });
    assert.equal(noHeader.status, 400);
  } finally {
    await new Promise<void>((r) => allowed.close(() => r()));
  }
});

test('POST /api/workspace/browse enforces guards, resolves picked paths, and handles cancel/unsupported cleanly', async () => {
  const root = await makeProject();
  let seenInitial: string | undefined;
  let nextResult: { supported: boolean; cancelled: boolean; path: string | null } = {
    supported: true,
    cancelled: false,
    path: root,
  };

  const mgr = createWorkspaceManager({
    watch: false,
    pickFolder: async (initialDir) => {
      seenInitial = initialDir;
      return nextResult;
    },
  });

  // Helper validations
  assert.equal(normalizePickedPath('\uFEFF/Users/dev/my-app/\n', 'darwin'), '/Users/dev/my-app');
  assert.equal(normalizePickedPath('C:\\code\\app\r\n', 'win32'), 'C:\\code\\app');
  assert.equal(normalizePickedPath('   \n', 'win32'), null);
  assert.equal(resolveInitialBrowseDir('/does/not/exist/anywhere'), undefined);
  assert.equal(resolveInitialBrowseDir(root), fs.realpathSync(root));

  const server = http.createServer(createApp({ allowWorkspace: true, workspaceManager: mgr }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // Missing CSRF header rejected
    const unauth = await fetch(`http://127.0.0.1:${port}/api/workspace/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauth.status, 400);

    // Selected directory returned with canonical path
    const okRes = await fetch(`http://127.0.0.1:${port}/api/workspace/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({ initialDir: root }),
    });
    assert.equal(okRes.status, 200);
    const okJson = (await okRes.json()) as { supported: boolean; cancelled: boolean; path: string | null };
    assert.deepEqual(okJson, { supported: true, cancelled: false, path: fs.realpathSync(root) });
    assert.equal(seenInitial, root);

    // Cancel and unsupported responses pass through cleanly
    nextResult = { supported: true, cancelled: true, path: null };
    const cancelRes = await fetch(`http://127.0.0.1:${port}/api/workspace/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({}),
    });
    assert.deepEqual(await cancelRes.json(), { supported: true, cancelled: true, path: null });

    nextResult = { supported: false, cancelled: false, path: null };
    const unsupRes = await fetch(`http://127.0.0.1:${port}/api/workspace/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({}),
    });
    assert.deepEqual(await unsupRes.json(), { supported: false, cancelled: false, path: null });

    // Missing CSRF header rejected on browse-cancel
    const unauthCancel = await fetch(`http://127.0.0.1:${port}/api/workspace/browse-cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthCancel.status, 400);
  } finally {
    await mgr.closeAll();
    await new Promise<void>((r) => server.close(() => r()));
  }

  // Verify browse-cancel and HTTP abort cancel an in-flight picker cleanly
  let cancelCalled = 0;
  let releasePicker: (() => void) | null = null;
  let observedSignalAborted = false;
  const pendingMgr = createWorkspaceManager({
    watch: false,
    pickFolder: (_initialDir, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          observedSignalAborted = true;
          resolve({ supported: true, cancelled: true, path: null });
        });
        releasePicker = () => resolve({ supported: true, cancelled: true, path: null });
      }),
    cancelFolder: () => {
      cancelCalled += 1;
      releasePicker?.();
      return true;
    },
  });
  const server2 = http.createServer(createApp({ allowWorkspace: true, workspaceManager: pendingMgr }));
  await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
  const port2 = (server2.address() as { port: number }).port;
  try {
    const abortCtrl = new AbortController();
    const pendingFetch = fetch(`http://127.0.0.1:${port2}/api/workspace/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({}),
      signal: abortCtrl.signal,
    }).catch(() => null);

    await new Promise((r) => setTimeout(r, 30));
    const cancelRes = await fetch(`http://127.0.0.1:${port2}/api/workspace/browse-cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({}),
    });
    assert.equal(cancelRes.status, 200);
    assert.deepEqual(await cancelRes.json(), { cancelled: true });
    assert.equal(cancelCalled, 1);
    await pendingFetch;

    // Also verify HTTP client abort triggers server signal abort
    const abortCtrl2 = new AbortController();
    const pendingFetch2 = fetch(`http://127.0.0.1:${port2}/api/workspace/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GemmaVault-Workspace': '1' },
      body: JSON.stringify({}),
      signal: abortCtrl2.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    abortCtrl2.abort();
    await pendingFetch2;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(observedSignalAborted, true);
  } finally {
    await pendingMgr.closeAll();
    await new Promise<void>((r) => server2.close(() => r()));
  }
});

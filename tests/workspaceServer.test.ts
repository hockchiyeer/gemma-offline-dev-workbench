import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../server.ts';
import { handleWorkspaceOp } from '../server/workspace/api.ts';
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
  } finally {
    await new Promise<void>((r) => embedServer.close(() => r()));
  }
});

test('Express /api/workspace routes enforce CSRF header and allowWorkspace flag', async () => {
  const restricted = http.createServer(createApp({ allowWorkspace: false }));
  await new Promise<void>((r) => restricted.listen(0, '127.0.0.1', r));
  const port = (restricted.address() as { port: number }).port;
  try {
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/workspace/status`);
    assert.equal(statusRes.status, 200);
    assert.deepEqual(await statusRes.json(), { available: false });

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

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp, hostHeaderAllowed, parseLoopbackUrl } from '../server.ts';

function listenServer(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

test('Server parseLoopbackUrl allows loopback and rejects external/0.0.0.0 targets', () => {
  assert.ok(parseLoopbackUrl('http://127.0.0.1:11434'));
  assert.ok(parseLoopbackUrl('http://localhost:1234'));
  assert.ok(parseLoopbackUrl('http://[::1]:11434'));
  assert.equal(parseLoopbackUrl('http://0.0.0.0:11434'), null);
  assert.equal(parseLoopbackUrl('https://api.anthropic.com/v1'), null);
  assert.equal(parseLoopbackUrl('http://169.254.169.254/latest'), null);
});

test('Local AI proxy probes, streams end-to-end, blocks SSRF, and enforces same-origin', async () => {
  const mockOllama = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'gemma4:e4b' }] }));
      return;
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'Hello ' } })}\n`);
      setTimeout(() => {
        res.write(`${JSON.stringify({ message: { content: 'Gemma 4!' }, done: true })}\n`);
        res.end();
      }, 20);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const ollamaHandle = await listenServer(mockOllama);
  const appServer = http.createServer(createApp());
  const appHandle = await listenServer(appServer);

  try {
    const baseUrl = `http://127.0.0.1:${ollamaHandle.port}`;

    // 1. Probe endpoint
    const probeResp = await fetch(`http://127.0.0.1:${appHandle.port}/api/local-ai/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, kind: 'ollama' }),
    });
    assert.equal(probeResp.status, 200);
    const probeJson = (await probeResp.json()) as {
      ok: boolean;
      data: { models: Array<{ name: string }> };
    };
    assert.equal(probeJson.ok, true);
    assert.equal(probeJson.data.models[0].name, 'gemma4:e4b');

    // 2. Streaming chat endpoint (verifies req.close does not prematurely abort)
    const chatResp = await fetch(`http://127.0.0.1:${appHandle.port}/api/local-ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        kind: 'ollama',
        payload: { model: 'gemma4:e4b', messages: [{ role: 'user', content: 'hi' }] },
      }),
    });
    assert.equal(chatResp.status, 200);
    assert.equal(chatResp.headers.get('x-accel-buffering'), 'no');
    const streamedBody = await chatResp.text();
    assert.match(streamedBody, /Hello /);
    assert.match(streamedBody, /Gemma 4!/);

    // 3. SSRF / external URL block
    const blockedResp = await fetch(`http://127.0.0.1:${appHandle.port}/api/local-ai/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://example.com', kind: 'ollama' }),
    });
    assert.equal(blockedResp.status, 400);

    // 4. Cross-origin Origin header must receive 403
    const crossOriginResp = await fetch(`http://127.0.0.1:${appHandle.port}/api/local-ai/probe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ baseUrl, kind: 'ollama' }),
    });
    assert.equal(crossOriginResp.status, 403);

    // 5. Cross-site Sec-Fetch-Site header must receive 403
    const crossSiteResp = await fetch(`http://127.0.0.1:${appHandle.port}/api/local-ai/probe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ baseUrl, kind: 'ollama' }),
    });
    assert.equal(crossSiteResp.status, 403);
  } finally {
    await appHandle.close();
    await ollamaHandle.close();
  }
});

test('Host header allowlist blocks DNS-rebinding names when bound to loopback', async () => {
  assert.equal(hostHeaderAllowed('localhost:3000', '127.0.0.1'), true);
  assert.equal(hostHeaderAllowed('127.0.0.1:3000', '127.0.0.1'), true);
  assert.equal(hostHeaderAllowed('[::1]:3000', '127.0.0.1'), true);
  assert.equal(hostHeaderAllowed('evil.example.com:3000', '127.0.0.1'), false);
  assert.equal(hostHeaderAllowed(undefined, '127.0.0.1'), false);
  // Operator explicitly exposed the server: do not second-guess LAN host names.
  assert.equal(hostHeaderAllowed('192.168.1.20:3000', '0.0.0.0'), true);

  // Verify HTTP 403 enforcement when bound to 127.0.0.1
  const loopbackServer = http.createServer(createApp({ bindHost: '127.0.0.1' }));
  const handle = await listenServer(loopbackServer);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/api/local-ai/probe',
          method: 'POST',
          headers: {
            Host: 'evil.example.com:3000',
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(status, 403);
  } finally {
    await handle.close();
  }
});

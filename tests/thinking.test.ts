import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import {
  THINKING_TOKEN_HEADROOM,
  streamLocalGemmaChat,
} from '../src/lib/gemmaClient.ts';
import type { LocalRuntimeConfig } from '../src/types/vault.ts';

function fakeServer(handler: (body: Record<string, unknown>, res: http.ServerResponse) => void) {
  return new Promise<{ url: string; close: () => void; body: () => Record<string, unknown> }>((resolve) => {
    let received: Record<string, unknown> = {};
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        received = JSON.parse(b) as Record<string, unknown>;
        handler(received, res);
      });
    });
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => srv.close(),
        body: () => received,
      })
    );
  });
}

function fakeOllama(lines: object[]) {
  return fakeServer((_body, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

const cfg = (baseUrl: string, kind: LocalRuntimeConfig['kind'] = 'ollama'): LocalRuntimeConfig => ({
  kind,
  baseUrl,
  selectedModel: 'gemma4:e4b',
  temperature: 0.2,
  maxTokens: 2048,
  contextTokens: 8192,
  systemPrompt: '',
});

test('thinking-only chunks are surfaced and the answer still arrives', async () => {
  const s = await fakeOllama([
    { message: { role: 'assistant', content: '', thinking: 'Let me ' } },
    { message: { role: 'assistant', content: '', thinking: 'think.' } },
    { message: { role: 'assistant', content: 'Hello' } },
    { message: { role: 'assistant', content: ' world' }, done: true, done_reason: 'stop' },
  ]);
  try {
    let think = '';
    let firstByteFired = false;
    const out = await streamLocalGemmaChat({
      config: cfg(s.url),
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      onFirstByte: () => {
        firstByteFired = true;
      },
      onToken: () => {},
      onThinking: (t) => (think = t),
    });
    assert.equal(out, 'Hello world');
    assert.equal(think, 'Let me think.');
    assert.equal(firstByteFired, true);
    const options = s.body().options as { num_predict: number };
    assert.equal(options.num_predict, 2048 + THINKING_TOKEN_HEADROOM, 'token budget has reasoning headroom');
  } finally {
    s.close();
  }
});

test('reasoning-only response that hits the limit gives an actionable error', async () => {
  const s = await fakeOllama([
    { message: { role: 'assistant', content: '', thinking: 'still thinking' } },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' },
  ]);
  try {
    await assert.rejects(
      streamLocalGemmaChat({
        config: cfg(s.url),
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        onToken: () => {},
      }),
      /token budget on reasoning/
    );
  } finally {
    s.close();
  }
});

test('OpenAI-compatible reasoning_content deltas are surfaced alongside content', async () => {
  const s = await fakeServer((_body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Step 1. ' } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
        '',
      ].join('\n')
    );
  });
  try {
    let think = '';
    const out = await streamLocalGemmaChat({
      config: cfg(s.url, 'openai'),
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      onToken: () => {},
      onThinking: (t) => (think = t),
    });
    assert.equal(out, 'Answer.');
    assert.equal(think, 'Step 1. ');
    assert.equal(s.body().max_tokens, 2048 + THINKING_TOKEN_HEADROOM);
  } finally {
    s.close();
  }
});

test('watchdog aborts a stalled stream with a readable error', async () => {
  let pendingRes: http.ServerResponse | undefined;
  const s = await fakeServer((_body, res) => {
    pendingRes = res;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  });
  try {
    await assert.rejects(
      streamLocalGemmaChat({
        config: cfg(s.url),
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        onToken: () => {},
        firstByteTimeoutMs: 40,
        idleTimeoutMs: 40,
      }),
      /stopped responding/
    );
  } finally {
    pendingRes?.destroy();
    s.close();
  }
});

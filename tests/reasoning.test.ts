import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { THINKING_TOKEN_HEADROOM, streamLocalGemmaChat, thinkingHeadroom } from '../src/lib/gemmaClient.ts';
import { DEFAULT_RUNTIME_CONFIG, sanitizeRuntimeConfig } from '../src/lib/db.ts';
import type { LocalRuntimeConfig } from '../src/types/vault.ts';

function fakeOllama(lines: object[]) {
  return new Promise<{ url: string; close: () => void; body: () => Record<string, unknown> }>((resolve) => {
    let received: Record<string, unknown> = {};
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        received = JSON.parse(b) as Record<string, unknown>;
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
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

const cfg = (baseUrl: string, reasoning?: 'auto' | 'off'): LocalRuntimeConfig => ({
  ...DEFAULT_RUNTIME_CONFIG,
  baseUrl,
  maxTokens: 2048,
  ...(reasoning ? { reasoning } : {}),
});

const run = (config: LocalRuntimeConfig) =>
  streamLocalGemmaChat({
    config,
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    onToken: () => {},
  });

test('sanitizeRuntimeConfig defaults reasoning to auto and accepts off', () => {
  assert.equal(sanitizeRuntimeConfig(null).reasoning, 'auto');
  assert.equal(sanitizeRuntimeConfig({ reasoning: 'off' }).reasoning, 'off');
  assert.equal(sanitizeRuntimeConfig({ reasoning: 'bogus' as never }).reasoning, 'auto');
});

test('thinkingHeadroom is zero only when reasoning is off', () => {
  assert.equal(thinkingHeadroom({ reasoning: 'off' }), 0);
  assert.equal(thinkingHeadroom({ reasoning: 'auto' }), THINKING_TOKEN_HEADROOM);
  assert.equal(thinkingHeadroom({}), THINKING_TOKEN_HEADROOM);
});

test('reasoning off sends think:false and no reasoning token headroom', async () => {
  const s = await fakeOllama([
    { message: { role: 'assistant', content: 'Direct answer' }, done: true, done_reason: 'stop' },
  ]);
  try {
    assert.equal(await run(cfg(s.url, 'off')), 'Direct answer');
    const body = s.body() as { think?: boolean; options: { num_predict: number } };
    assert.equal(body.think, false);
    assert.equal(body.options.num_predict, 2048);
  } finally {
    s.close();
  }
});

test('reasoning auto does not send a think field', async () => {
  const s = await fakeOllama([{ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }]);
  try {
    await run(cfg(s.url, 'auto'));
    assert.equal('think' in s.body(), false);
  } finally {
    s.close();
  }
});

test('reasoning off with an empty answer gives an actionable error', async () => {
  const s = await fakeOllama([{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }]);
  try {
    await assert.rejects(run(cfg(s.url, 'off')), /set Reasoning to "Auto"/);
  } finally {
    s.close();
  }
});

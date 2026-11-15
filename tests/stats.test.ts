import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { keepAliveValue, streamLocalGemmaChat } from '../src/lib/gemmaClient.ts';
import {
  COMPACTION_SYSTEM_PROMPT,
  chunkForSummary,
  compactConversation,
  renderForSummary,
} from '../src/lib/compaction.ts';
import { sanitizeRuntimeConfig } from '../src/lib/db.ts';
import type { ChatMessage, GenerationStats, LocalRuntimeConfig } from '../src/types/vault.ts';

type Body = Record<string, unknown>;

function fakeServer(handler: (body: Body, res: http.ServerResponse, n: number) => void) {
  return new Promise<{ url: string; close: () => void; bodies: Body[] }>((resolve) => {
    const bodies: Body[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const parsed = JSON.parse(b) as Body;
        bodies.push(parsed);
        handler(parsed, res, bodies.length);
      });
    });
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => srv.close(),
        bodies,
      })
    );
  });
}

const ndjson = (res: http.ServerResponse, lines: object[]) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

const cfg = (baseUrl: string, over: Partial<LocalRuntimeConfig> = {}): LocalRuntimeConfig => ({
  kind: 'ollama',
  baseUrl,
  selectedModel: 'gemma4:e4b',
  temperature: 0.2,
  maxTokens: 2048,
  contextTokens: 8192,
  systemPrompt: '',
  ...over,
});

const run = (config: LocalRuntimeConfig) => {
  let stats: GenerationStats | undefined;
  let calls = 0;
  const promise = streamLocalGemmaChat({
    config,
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    onToken: () => {},
    onStats: (s) => {
      stats = s;
      calls++;
    },
  });
  return { promise, get: () => ({ stats, calls }) };
};

test('Ollama: final-chunk counts and timings become stats, with tokens/sec from eval_duration', async () => {
  const s = await fakeServer((_b, res) =>
    ndjson(res, [
      { message: { role: 'assistant', content: 'Hello' } },
      {
        message: { role: 'assistant', content: ' world' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 321,
        eval_count: 40,
        load_duration: 2_500_000_000,
        prompt_eval_duration: 800_000_000,
        eval_duration: 2_000_000_000,
      },
    ])
  );
  try {
    const r = run(cfg(s.url));
    assert.equal(await r.promise, 'Hello world');
    assert.deepEqual(r.get().stats, {
      promptTokens: 321,
      completionTokens: 40,
      loadMs: 2500,
      promptEvalMs: 800,
      tokensPerSecond: 20,
    });
    assert.equal(r.get().calls, 1);
  } finally {
    s.close();
  }
});

test('stats are omitted (callback not fired) when the runtime reports no counts', async () => {
  const s = await fakeServer((_b, res) =>
    ndjson(res, [{ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }])
  );
  try {
    const r = run(cfg(s.url));
    await r.promise;
    assert.equal(r.get().calls, 0);
  } finally {
    s.close();
  }
});

test('OpenAI-compatible: usage chunk is read and include_usage is requested', async () => {
  const s = await fakeServer((_b, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } })}`,
        'data: [DONE]',
        '',
      ].join('\n')
    );
  });
  try {
    const r = run(cfg(s.url, { kind: 'openai' }));
    assert.equal(await r.promise, 'Hi');
    const got = r.get().stats!;
    assert.equal(got.promptTokens, 120);
    assert.equal(got.completionTokens, 7);
    assert.deepEqual(s.bodies[0].stream_options, { include_usage: true });
  } finally {
    s.close();
  }
});

test('llama.cpp style timings are understood', async () => {
  const s = await fakeServer((_b, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}`,
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          timings: { prompt_n: 55, prompt_ms: 410.5, predicted_n: 12, predicted_per_second: 31.46 },
        })}`,
        'data: [DONE]',
        '',
      ].join('\n')
    );
  });
  try {
    const r = run(cfg(s.url, { kind: 'openai' }));
    await r.promise;
    assert.deepEqual(r.get().stats, {
      promptTokens: 55,
      completionTokens: 12,
      promptEvalMs: 410.5,
      tokensPerSecond: 31.5,
    });
  } finally {
    s.close();
  }
});

test('keep_alive: sent for Ollama only, 0 unloads, undefined leaves the Ollama default', async () => {
  assert.equal(keepAliveValue(undefined), undefined);
  assert.equal(keepAliveValue(Number.NaN), undefined);
  assert.equal(keepAliveValue(0), 0);
  assert.equal(keepAliveValue(-5), 0);
  assert.equal(keepAliveValue(30), '30m');
  assert.equal(keepAliveValue(7.6), '8m');

  const send = async (config: (url: string) => LocalRuntimeConfig, sse = false) => {
    const s = await fakeServer((_b, res) => {
      if (sse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\ndata: [DONE]\n\n`);
      } else {
        ndjson(res, [{ message: { content: 'x' }, done: true, done_reason: 'stop' }]);
      }
    });
    try {
      await run(config(s.url)).promise;
      return s.bodies[0];
    } finally {
      s.close();
    }
  };

  assert.equal((await send((u) => cfg(u, { keepAliveMinutes: 30 }))).keep_alive, '30m');
  assert.equal((await send((u) => cfg(u, { keepAliveMinutes: 0 }))).keep_alive, 0);
  assert.equal('keep_alive' in (await send((u) => cfg(u))), false);
  assert.equal('keep_alive' in (await send((u) => cfg(u, { kind: 'openai', keepAliveMinutes: 30 }), true)), false);
});

test('runtime config: keep-alive and auto-compact are sanitised, with safe defaults', () => {
  const d = sanitizeRuntimeConfig(null);
  assert.equal(d.keepAliveMinutes, 30);
  assert.equal(d.autoCompact, true);
  assert.equal(sanitizeRuntimeConfig({ keepAliveMinutes: 99999 }).keepAliveMinutes, 1440);
  assert.equal(sanitizeRuntimeConfig({ keepAliveMinutes: -4 }).keepAliveMinutes, 0);
  assert.equal(sanitizeRuntimeConfig({ keepAliveMinutes: 0 }).keepAliveMinutes, 0);
  assert.equal(sanitizeRuntimeConfig({ autoCompact: false }).autoCompact, false);
  assert.equal(sanitizeRuntimeConfig({ autoCompact: undefined }).autoCompact, true);
});

// ---------------------------------------------------------------------------------------------
// Compaction runner
// ---------------------------------------------------------------------------------------------

let id = 0;
const msg = (role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++id}`,
  role,
  content,
  createdAt: id,
  ...extra,
});

test('renderForSummary abbreviates attached context and caps very long messages', () => {
  const withCtx = msg('user', 'Why does it crash?', {
    sentContext: 'Attached Local Vault Context:\n--- SNIPPET: parser.ts (typescript) ---\n```ts\nsecret code\n```',
  });
  const r = renderForSummary(withCtx);
  assert.ok(r.startsWith('[user] [attached: SNIPPET: parser.ts (typescript)] '));
  assert.ok(!r.includes('secret code'));
  const long = renderForSummary(msg('assistant', 'line\n'.repeat(5000)));
  assert.ok(long.length < 2600);
  assert.ok(long.startsWith('[assistant] '));
});

test('chunkForSummary splits to the allowance and never returns an empty chunk', () => {
  const rendered = Array.from({ length: 10 }, (_, i) => `[user] ${i} ` + 'word '.repeat(150));
  const chunks = chunkForSummary(rendered, 500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, 10);
  assert.ok(chunks.every((c) => c.length > 0));
  assert.deepEqual(chunkForSummary([], 500), []);
});

test('compactConversation: merges prior note + transcript, uses the summariser prompt, reasoning off', async () => {
  const s = await fakeServer((_b, res) =>
    ndjson(res, [
      { message: { content: '```\n## Goal\nShip the parser.\n```' } },
      { message: { content: '' }, done: true, done_reason: 'stop' },
    ])
  );
  try {
    const out = await compactConversation({
      config: cfg(s.url, { reasoning: 'auto', maxTokens: 4096 }),
      previous: { text: 'OLD NOTE', coversUpToMessageId: 'x', updatedAt: 1 },
      messages: [msg('user', 'Use a Pratt parser'), msg('assistant', 'Sure, here is the plan')],
      signal: new AbortController().signal,
    });
    assert.equal(out, '## Goal\nShip the parser.');
    const body = s.bodies[0] as { messages: Array<{ role: string; content: string }>; think?: boolean; options: { num_predict: number } };
    assert.equal(body.messages[0].content, COMPACTION_SYSTEM_PROMPT);
    assert.ok(body.messages[1].content.includes('OLD NOTE'));
    assert.ok(body.messages[1].content.includes('[user] Use a Pratt parser'));
    assert.equal(body.think, false, 'summaries skip the reasoning phase');
    assert.equal(body.options.num_predict, 700, 'summary reply is capped independently of the chat setting');
  } finally {
    s.close();
  }
});

test('compactConversation: retries once with reasoning on if the build answers nothing with it off', async () => {
  const s = await fakeServer((body, res, n) => {
    if (n === 1) {
      ndjson(res, [{ message: { content: '' }, done: true, done_reason: 'stop' }]);
    } else {
      ndjson(res, [{ message: { content: '## Goal\nok' }, done: true, done_reason: 'stop' }]);
    }
  });
  try {
    const out = await compactConversation({
      config: cfg(s.url),
      messages: [msg('user', 'a'), msg('assistant', 'b')],
      signal: new AbortController().signal,
    });
    assert.equal(out, '## Goal\nok');
    assert.equal(s.bodies.length, 2);
    assert.equal(s.bodies[0].think, false);
    assert.equal('think' in s.bodies[1], false);
  } finally {
    s.close();
  }
});

test('compactConversation: rolls long transcripts through several passes, each seeing the previous note', async () => {
  const s = await fakeServer((_b, res, n) =>
    ndjson(res, [{ message: { content: `NOTE-${n}` }, done: true, done_reason: 'stop' }])
  );
  try {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 14; i++) messages.push(msg('user', `q${i} ` + 'x '.repeat(900)), msg('assistant', `a${i} ` + 'y '.repeat(900)));
    const out = await compactConversation({
      config: cfg(s.url, { contextTokens: 4096 }),
      messages,
      signal: new AbortController().signal,
    });
    assert.ok(s.bodies.length >= 2, 'expected several passes');
    assert.equal(out, `NOTE-${s.bodies.length}`);
    const second = (s.bodies[1].messages as Array<{ content: string }>)[1].content;
    assert.ok(second.includes('NOTE-1'), 'pass 2 receives the note produced by pass 1');
  } finally {
    s.close();
  }
});

test('compactConversation: failures and aborts surface to the caller', async () => {
  const empty = await fakeServer((_b, res) =>
    ndjson(res, [{ message: { content: '   ' }, done: true, done_reason: 'stop' }, ])
  );
  try {
    await assert.rejects(
      compactConversation({
        config: cfg(empty.url, { reasoning: 'auto' }),
        messages: [msg('user', 'a'), msg('assistant', 'b')],
        signal: new AbortController().signal,
      })
    );
  } finally {
    empty.close();
  }

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    compactConversation({
      config: cfg('http://127.0.0.1:9'),
      messages: [msg('user', 'a'), msg('assistant', 'b')],
      signal: ac.signal,
    }),
    (e: unknown) => (e as { name?: string }).name === 'AbortError'
  );
  await assert.rejects(
    compactConversation({ config: cfg('http://127.0.0.1:9'), messages: [], signal: new AbortController().signal }),
    /Nothing to summarise/
  );
});

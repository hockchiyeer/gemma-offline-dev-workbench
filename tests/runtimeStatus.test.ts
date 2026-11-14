import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAndRankModel, type ProbeResult } from '../src/lib/gemmaClient.ts';
import type { SetupStatus } from '../src/lib/gemmaSetup.ts';
import { deriveRuntimeStatus, nextPollDelayMs } from '../src/lib/runtimeStatus.ts';
import type { LocalRuntimeConfig } from '../src/types/vault.ts';

const config: Pick<LocalRuntimeConfig, 'kind' | 'baseUrl' | 'selectedModel'> = {
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  selectedModel: 'gemma4:e4b',
};
const down: ProbeResult = {
  connected: false,
  transport: 'none',
  models: [],
  recommendedModel: null,
};
const up = (names: string[], version?: string): ProbeResult => {
  const models = names.map((n) => classifyAndRankModel(n));
  return {
    connected: true,
    transport: 'proxy',
    models,
    recommendedModel: models[0] ?? null,
    version,
  };
};
const setup = (
  over: Partial<SetupStatus['system']> = {},
  job: Partial<SetupStatus['job']> = {}
): SetupStatus => ({
  system: {
    platform: 'win32',
    totalMemGiB: 16,
    ollamaInstalled: true,
    ollamaRunning: false,
    installedModels: [],
    recommendedModel: 'gemma4:e4b',
    ...over,
  },
  job: {
    phase: 'idle',
    message: '',
    percent: null,
    model: 'gemma4:e4b',
    running: false,
    ...job,
  },
});
const derive = (probe: ProbeResult, s: SetupStatus | null, checked = true, cfg = config) =>
  deriveRuntimeStatus({ checked, probe, setup: s, config: cfg });

test('never claims "down" before the first check finishes', () => {
  assert.equal(derive(down, null, false).level, 'checking');
});

test('ready: shows model and Ollama version', () => {
  const st = derive(up(['gemma4:e4b'], '0.12.3'), setup({ ollamaRunning: true }));
  assert.equal(st.level, 'ready');
  assert.equal(st.tone, 'ok');
  assert.equal(st.model, 'gemma4:e4b');
  assert.match(st.detail, /Ollama v0\.12\.3/);
  assert.match(st.detail, /gemma4:e4b/);
});

test('ready falls back to the recommended installed Gemma when the selected one is missing', () => {
  const st = derive(up(['gemma4:26b']), setup({ ollamaRunning: true }));
  assert.equal(st.level, 'ready');
  assert.equal(st.model, 'gemma4:26b');
});

test('up but only non-Gemma or non-chat Gemma models -> "no-model", not ready', () => {
  const nonGemma = derive(up(['llama3:8b']), setup({ ollamaRunning: true }));
  assert.equal(nonGemma.level, 'no-model');
  assert.equal(nonGemma.tone, 'warn');
  assert.match(nonGemma.label, /no Gemma/i);

  const embedOnly = derive(up(['embeddinggemma:300m']), setup({ ollamaRunning: true }));
  assert.equal(embedOnly.level, 'no-model');
  assert.equal(embedOnly.tone, 'warn');
});

test('down with Ollama not installed vs installed-but-stopped are distinguished', () => {
  const missing = derive(down, setup({ ollamaInstalled: false }));
  assert.equal(missing.level, 'not-installed');
  assert.match(missing.detail, /web app is running/i);
  const stopped = derive(down, setup({ ollamaInstalled: true }));
  assert.equal(stopped.level, 'down');
  assert.match(stopped.detail, /installed and not running/i);
});

test('down without setup info (static PWA / network-exposed) names the URL', () => {
  const st = derive(down, null);
  assert.equal(st.level, 'down');
  assert.match(st.detail, /127\.0\.0\.1:11434/);
});

test('failed setup attempt is surfaced', () => {
  const st = derive(down, setup({}, { phase: 'error', error: 'firewall blocked ollama.com' }));
  assert.match(st.detail, /firewall blocked ollama\.com/);
});

test('setup job phases map to starting / installing with progress, and beat a stale probe', () => {
  const starting = derive(
    down,
    setup({}, { running: true, phase: 'starting-ollama', message: 'Starting the local Ollama service…' })
  );
  assert.equal(starting.level, 'starting');
  assert.equal(starting.tone, 'busy');
  const installing = derive(
    down,
    setup({}, { running: true, phase: 'installing', message: 'Installing', percent: 40 })
  );
  assert.equal(installing.level, 'installing');
  assert.match(installing.label, /Installing Ollama/);
  const pulling = derive(
    up(['llama3:8b']),
    setup({}, { running: true, phase: 'pulling-model', message: 'gemma4:e4b: pulling', percent: 63 })
  );
  assert.equal(pulling.level, 'installing');
  assert.equal(pulling.percent, 63);
  assert.match(pulling.label, /Downloading Gemma/);
});

test('OpenAI-compatible runtime: any model counts, no Ollama version claimed', () => {
  const st = derive(up(['my-custom-gguf']), null, true, {
    ...config,
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234',
    selectedModel: 'my-custom-gguf',
  });
  assert.equal(st.level, 'ready');
  assert.doesNotMatch(st.detail, /Ollama v/);
});

test('poll cadence: fast while busy, relaxed when healthy', () => {
  assert.equal(nextPollDelayMs(derive(down, setup({}, { running: true, phase: 'installing' }))), 1500);
  assert.equal(nextPollDelayMs(derive(up(['gemma4:e4b']), null)), 15000);
  assert.equal(nextPollDelayMs(derive(down, null)), 5000);
});

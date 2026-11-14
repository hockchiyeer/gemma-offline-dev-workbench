import type { LocalRuntimeConfig } from '../types/vault';
import type { ProbeResult } from './gemmaClient';
import type { SetupStatus } from './gemmaSetup';

export type RuntimeLevel =
  | 'checking'
  | 'ready'
  | 'no-model'
  | 'starting'
  | 'installing'
  | 'down'
  | 'not-installed';

export type RuntimeTone = 'ok' | 'warn' | 'bad' | 'busy' | 'neutral';

export interface RuntimeStatus {
  level: RuntimeLevel;
  tone: RuntimeTone;
  /** Short headline, e.g. "Local LLM ready". */
  label: string;
  /** One sentence of context / next step. */
  detail: string;
  /** Model that will answer chat requests when ready. */
  model?: string;
  /** Runtime build version, when reported (Ollama). */
  version?: string;
  /** 0-100 while a setup job reports progress. */
  percent?: number | null;
}

export interface RuntimeStatusInput {
  /** False until the first probe has finished, so we never flash "down" at page load. */
  checked: boolean;
  probe: ProbeResult;
  setup: SetupStatus | null;
  config: Pick<LocalRuntimeConfig, 'kind' | 'baseUrl' | 'selectedModel'>;
}

const runtimeName = (kind: LocalRuntimeConfig['kind']) =>
  kind === 'openai' ? 'The local OpenAI-compatible server' : 'Ollama';

/**
 * Collapses "is the probe answering?", "is a setup job running?" and "what does the server know about the
 * install?" into ONE state, so the page can say plainly whether only the web app is up or the LLM is too.
 */
export function deriveRuntimeStatus(input: RuntimeStatusInput): RuntimeStatus {
  const { checked, probe, setup, config } = input;
  const job = setup?.job;

  // A setup job in flight always wins: it explains why the LLM is not (yet) usable.
  if (job?.running) {
    if (job.phase === 'pulling-model') {
      return {
        level: 'installing',
        tone: 'busy',
        label: 'Downloading Gemma model…',
        detail: `${job.message} Chat is unavailable until it finishes.`,
        percent: job.percent,
      };
    }
    if (
      job.phase === 'downloading-installer' ||
      job.phase === 'verifying' ||
      job.phase === 'installing'
    ) {
      return {
        level: 'installing',
        tone: 'busy',
        label: 'Installing Ollama…',
        detail: job.message,
        percent: job.percent,
      };
    }
    return {
      level: 'starting',
      tone: 'busy',
      label: 'Starting local LLM…',
      detail: job.message || 'Checking Ollama and starting it if needed.',
      percent: job.percent,
    };
  }

  if (!checked) {
    return {
      level: 'checking',
      tone: 'neutral',
      label: 'Checking local LLM…',
      detail: 'Looking for a local Gemma runtime.',
    };
  }

  if (probe.connected) {
    const name = runtimeName(config.kind);
    const usable =
      config.kind === 'openai'
        ? probe.models
        : probe.models.filter((m) => m.family !== 'other' && m.rankScore > 0);
    if (usable.length === 0) {
      const other = probe.models.length
        ? ` It only has non-chat/non-Gemma models (${probe.models.length}).`
        : '';
      return {
        level: 'no-model',
        tone: 'warn',
        label: `${name} is running — no Gemma model`,
        detail: `${other} Install one with "npm run setup:gemma" or Runtime settings → Auto-setup.`.trim(),
        version: probe.version,
      };
    }
    const selected = usable.find((m) => m.name === config.selectedModel);
    const model = (
      selected ??
      (probe.recommendedModel && probe.recommendedModel.rankScore > 0
        ? probe.recommendedModel
        : undefined) ??
      usable[0]
    ).name;
    return {
      level: 'ready',
      tone: 'ok',
      label: 'Local LLM ready',
      detail: [
        model,
        probe.version ? `Ollama v${probe.version}` : name,
        `${usable.length} model${usable.length === 1 ? '' : 's'}`,
      ].join(' · '),
      model,
      version: probe.version,
    };
  }

  // Not reachable. Use what the local server knows about the install to be specific.
  const sys = setup?.system;
  if (sys && config.kind === 'ollama' && !sys.ollamaInstalled) {
    return {
      level: 'not-installed',
      tone: 'bad',
      label: 'Local LLM not installed',
      detail:
        'The web app is running, but Ollama is not installed. Run "npm run setup:gemma" or use Runtime settings → Auto-setup (one-time download).',
    };
  }
  const failed =
    job && !job.running && job.phase === 'error'
      ? ` Last setup attempt failed: ${job.error ?? job.message}`
      : '';
  if (sys && config.kind === 'ollama' && sys.ollamaInstalled) {
    return {
      level: 'down',
      tone: 'bad',
      label: 'Local LLM is down',
      detail: `The web app is running, but Ollama is installed and not running. Start the Ollama app or run "npm run setup:gemma".${failed}`,
    };
  }
  return {
    level: 'down',
    tone: 'bad',
    label: 'Local LLM is down',
    detail: `The web app is running, but nothing answered at ${config.baseUrl}. Start your local runtime, then it reconnects automatically.${failed}`,
  };
}

/** How long to wait before the next background check. */
export function nextPollDelayMs(status: RuntimeStatus): number {
  switch (status.level) {
    case 'starting':
    case 'installing':
      return 1500;
    case 'ready':
      return 15000;
    default:
      return 5000;
  }
}

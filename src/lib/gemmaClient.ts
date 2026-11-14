import type { ChatMessage, GemmaModelInfo, LocalRuntimeConfig } from '../types/vault';

export interface ProbeResult {
  connected: boolean;
  transport: 'direct' | 'proxy' | 'none';
  models: GemmaModelInfo[];
  recommendedModel: GemmaModelInfo | null;
  /** Ollama build version (e.g. "0.12.3") when the runtime reports one. */
  version?: string;
  error?: string;
}

export interface WebGPUStatus {
  supported: boolean;
  adapterName?: string;
}

export interface RecommendedModelSpec {
  tag: string;
  note: string;
}

export const RECOMMENDED_GEMMA_MODELS: RecommendedModelSpec[] = [
  { tag: 'gemma4:31b', note: 'Flagship Google Gemma 4 dense reasoning & coding (24 GB+ RAM)' },
  { tag: 'gemma4:26b', note: 'Gemma 4 26B MoE high-speed coding & architecture (18 GB RAM)' },
  { tag: 'gemma4:12b', note: 'Gemma 4 12B Unified mid-tier coding model between E4B and 26B (~8 GB download)' },
  { tag: 'gemma4:e4b', note: 'Balanced everyday Gemma 4 coding model for laptops (6–8 GB RAM)' },
  { tag: 'gemma4:e2b', note: 'Ultra-light Gemma 4 edge model for low-RAM devices (3–4 GB RAM)' },
  { tag: 'gemma3n:e4b', note: 'Gemma 3n multimodal-ready efficient local edge model (5 GB RAM)' },
  { tag: 'gemma3:12b', note: 'Gemma 3 12B coding & refactoring workhorse (9 GB RAM)' },
  { tag: 'codegemma:7b', note: 'Code-specialized model for completion & fill-in-middle (6 GB RAM)' },
];

export function isLoopbackBaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function parseParamBillions(lower: string): { label: string; billions: number } | null {
  const paramMatch = lower.match(/(?:^|[:\-_/\s])(e?\d+(?:\.\d+)?b)(?:$|[:\-_/\s])/);
  if (!paramMatch) return null;
  const rawToken = paramMatch[1];
  const numeric = parseFloat(rawToken.replace(/^e/, ''));
  if (Number.isNaN(numeric)) return null;
  return { label: rawToken.toUpperCase(), billions: numeric };
}

// Tags without an explicit size resolve to these defaults in the Ollama library.
const LATEST_TAG_PARAMS: Record<string, number> = {
  gemma4: 4,
  gemma3n: 4,
  gemma3: 4,
  gemma2: 9,
  codegemma: 7,
  gemma: 7,
};

/** Embedding / safety-classifier / vision-only variants cannot chat and must never be auto-selected. */
const NON_CHAT_RE = /(embedding|shield|siglip|paligemma)/;

/**
 * Capability multiplier per generation. A newer generation is worth ≈2.4x the parameters of
 * Gemma 3 (Gemma 4 12B ≈ Gemma 3 27B class), so a large older model can still beat a tiny
 * new one while, at equal size, the newest generation always wins. Future generations
 * (gemma5, ...) scale upward automatically instead of falling into a generic bucket.
 */
export function generationFactor(family: GemmaModelInfo['family'], generation: number): number {
  if (family === 'codegemma') return 0.6;
  if (generation >= 4) return 2.4 + (generation - 4) * 0.8;
  if (generation === 3) return 1.0;
  if (generation === 2) return 0.7;
  return 0.5;
}

// Rank free Google Gemma models: higher = more capable. Non-chat variants and non-Gemma models rank 0.
export function classifyAndRankModel(
  name: string,
  sizeBytes?: number,
  quantization?: string
): GemmaModelInfo {
  const lower = name.toLowerCase();
  const base = lower.split('/').pop() || lower;
  let family: GemmaModelInfo['family'] = 'other';
  let generation = 0;

  const gen = base.match(/gemma[-_ ]?(\d+)(n)?(?![a-z0-9])/);
  if (base.includes('codegemma')) {
    family = 'codegemma';
    generation = 1;
  } else if (gen) {
    generation = parseInt(gen[1], 10);
    family =
      generation === 4
        ? 'gemma4'
        : generation === 3
          ? gen[2]
            ? 'gemma3n'
            : 'gemma3'
          : generation === 2
            ? 'gemma2'
            : 'gemma';
  } else if (base.includes('gemma')) {
    family = 'gemma';
    generation = 1;
  }

  let parameterLabel = '';
  let billions = 0;
  const parsedParam = parseParamBillions(lower);
  if (parsedParam) {
    parameterLabel = parsedParam.label;
    billions = parsedParam.billions;
  } else if (family !== 'other') {
    billions = LATEST_TAG_PARAMS[family] ?? 0;
    // Bare "gemma4" tag in Ollama aliases to E4B
    if (family === 'gemma4' && !lower.includes(':')) parameterLabel = 'E4B';
  }

  const chatCapable = !NON_CHAT_RE.test(base);
  const rankScore =
    family === 'other' || !chatCapable
      ? 0
      : Math.max(0.1, billions) * generationFactor(family, generation);

  return {
    id: name,
    name,
    family,
    parameterLabel,
    sizeBytes,
    quantization,
    rankScore,
  };
}

/** Best installed chat-capable Gemma; falls back to any other model, never an embedding/safety variant. */
export function pickRecommendedModel(models: GemmaModelInfo[]): GemmaModelInfo | null {
  const sorted = [...models].sort((a, b) => b.rankScore - a.rankScore);
  return (
    sorted.find((m) => m.family !== 'other' && m.rankScore > 0) ||
    sorted.find((m) => m.family === 'other') ||
    null
  );
}

export async function inspectWebGPU(): Promise<WebGPUStatus> {
  try {
    const nav = navigator as unknown as {
      gpu?: {
        requestAdapter: () => Promise<{ info?: { device?: string; architecture?: string } } | null>;
      };
    };
    if (!nav.gpu) return { supported: false };
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { supported: false };
    const info = adapter.info;
    const adapterName =
      [info?.architecture, info?.device].filter(Boolean).join(' · ') || 'WebGPU Adapter Ready';
    return { supported: true, adapterName };
  } catch {
    return { supported: false };
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function parseModelsResponse(
  kind: LocalRuntimeConfig['kind'],
  data: unknown
): Promise<GemmaModelInfo[]> {
  const rawList: Array<{ name: string; size?: number; quant?: string }> = [];

  if (kind === 'ollama') {
    const models =
      (
        data as {
          models?: Array<{
            name?: string;
            model?: string;
            size?: number;
            details?: { quantization_level?: string };
          }>;
        }
      )?.models || [];
    for (const m of models) {
      const id = m.name || m.model;
      if (id) {
        rawList.push({
          name: id,
          size: m.size,
          quant: m.details?.quantization_level,
        });
      }
    }
  } else {
    const models = (data as { data?: Array<{ id?: string }> })?.data || [];
    for (const m of models) {
      if (m.id) rawList.push({ name: m.id });
    }
  }

  return rawList
    .map((m) => classifyAndRankModel(m.name, m.size, m.quant))
    .sort((a, b) => b.rankScore - a.rankScore);
}

async function fetchOllamaVersionDirect(baseUrl: string): Promise<string | undefined> {
  try {
    const resp = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version.slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
}

export async function probeLocalGemmaRuntime(config: LocalRuntimeConfig): Promise<ProbeResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!isLoopbackBaseUrl(baseUrl)) {
    return {
      connected: false,
      transport: 'none',
      models: [],
      recommendedModel: null,
      error: 'Endpoint must target localhost or 127.0.0.1 to guarantee offline-only execution.',
    };
  }

  const endpointPath = config.kind === 'openai' ? '/v1/models' : '/api/tags';

  // 1. Try direct browser loopback connection first (works in pure offline standalone PWA)
  const directController = new AbortController();
  const directTimer = setTimeout(() => directController.abort(), 1800);
  try {
    const resp = await fetch(`${baseUrl}${endpointPath}`, { signal: directController.signal });
    if (resp.ok) {
      const json = await resp.json();
      const models = await parseModelsResponse(config.kind, json);
      const recommendedModel = pickRecommendedModel(models);
      const version =
        config.kind === 'ollama' ? await fetchOllamaVersionDirect(baseUrl) : undefined;
      return {
        connected: true,
        transport: 'direct',
        models,
        recommendedModel,
        version,
      };
    }
  } catch {
    // Fall through to local Express loopback proxy
  } finally {
    clearTimeout(directTimer);
  }

  // 2. Try same-origin loopback proxy (bypasses Ollama CORS when running via server.ts)
  const proxyController = new AbortController();
  const proxyTimer = setTimeout(() => proxyController.abort(), 2200);
  try {
    const resp = await fetch('/api/local-ai/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, kind: config.kind }),
      signal: proxyController.signal,
    });
    if (resp.ok) {
      const wrapper = (await resp.json()) as {
        ok?: boolean;
        data?: unknown;
        version?: unknown;
      };
      if (wrapper.ok && wrapper.data) {
        const models = await parseModelsResponse(config.kind, wrapper.data);
        const recommendedModel = pickRecommendedModel(models);
        return {
          connected: true,
          transport: 'proxy',
          models,
          recommendedModel,
          version: typeof wrapper.version === 'string' ? wrapper.version : undefined,
        };
      }
    }
  } catch {
    // Both paths unreachable
  } finally {
    clearTimeout(proxyTimer);
  }

  return {
    connected: false,
    transport: 'none',
    models: [],
    recommendedModel: null,
    error: `No local Gemma runtime detected at ${baseUrl}. Start Ollama or LM Studio on this device.`,
  };
}

export interface StreamGemmaOptions {
  config: LocalRuntimeConfig;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  transportHint?: 'direct' | 'proxy' | 'none';
  signal: AbortSignal;
  onToken: (partialText: string) => void;
}

export async function streamLocalGemmaChat({
  config,
  messages,
  transportHint,
  signal,
  onToken,
}: StreamGemmaOptions): Promise<string> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!isLoopbackBaseUrl(baseUrl)) {
    throw new Error('Blocked non-local endpoint. Configure a localhost or 127.0.0.1 URL.');
  }

  const numCtx = config.contextTokens ?? 8192;
  const payload =
    config.kind === 'ollama'
      ? {
          model: config.selectedModel,
          messages,
          stream: true,
          options: {
            temperature: config.temperature,
            num_predict: config.maxTokens,
            num_ctx: numCtx,
          },
        }
      : {
          model: config.selectedModel,
          messages,
          stream: true,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
        };

  let response: Response | null = null;

  if (transportHint !== 'proxy') {
    try {
      const directPath = config.kind === 'openai' ? '/v1/chat/completions' : '/api/chat';
      // Keep any actual HTTP response (including 4xx model errors) so real runtime errors surface.
      response = await fetch(`${baseUrl}${directPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      response = null;
    }
  }

  if (!response) {
    response = await fetch('/api/local-ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        kind: config.kind,
        payload,
      }),
      signal,
    });
  }

  if (!response.ok || !response.body) {
    let errDetail = `Local Gemma runtime error (HTTP ${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson?.error) errDetail = typeof errJson.error === 'string' ? errJson.error : errJson.error.message || errDetail;
    } catch {
      // ignore
    }
    throw new Error(errDetail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;

    if (config.kind === 'ollama') {
      try {
        const parsed = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.message?.content) {
          accumulated += parsed.message.content;
          onToken(accumulated);
        }
      } catch (err) {
        if (err instanceof Error && line.includes('"error"')) {
          throw err;
        }
      }
    } else {
      if (!line.startsWith('data:')) return;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') return;
      try {
        const parsed = JSON.parse(dataStr) as {
          choices?: Array<{ delta?: { content?: string } }>;
          error?: { message?: string };
        };
        if (parsed.error?.message) {
          throw new Error(parsed.error.message);
        }
        const chunk = parsed.choices?.[0]?.delta?.content;
        if (chunk) {
          accumulated += chunk;
          onToken(accumulated);
        }
      } catch (err) {
        if (err instanceof Error && line.includes('"error"')) {
          throw err;
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    processLine(buffer);
  }

  return accumulated;
}

export interface BuiltGemmaPayload {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  truncated: boolean;
}

const DEFAULT_MAX_CONTEXT_CHARS = 24_000;

export function buildGemmaMessages(
  systemPrompt: string,
  history: ChatMessage[],
  contextBlocks: Array<{ title: string; kind: string; content: string }>,
  budget?: number | { contextTokens?: number; reserveForReply?: number }
): BuiltGemmaPayload {
  let maxChars = DEFAULT_MAX_CONTEXT_CHARS;
  if (typeof budget === 'number') {
    maxChars = Math.max(2000, budget);
  } else if (budget && typeof budget === 'object') {
    const ctxTokens = budget.contextTokens ?? 8192;
    const reserve = budget.reserveForReply ?? 2048;
    const usableTokens = Math.max(1024, ctxTokens - reserve);
    maxChars = Math.max(4000, Math.floor(usableTokens * 3.2));
  }

  let truncated = false;
  const maxContextChars = Math.floor(maxChars * 0.55);

  let contextText = '';
  if (contextBlocks.length > 0) {
    const parts: string[] = [];
    let used = 0;
    for (const block of contextBlocks) {
      const formatted = `--- ${block.kind.toUpperCase()}: ${block.title} ---\n${block.content}`;
      if (used + formatted.length <= maxContextChars) {
        parts.push(formatted);
        used += formatted.length;
      } else {
        const remaining = Math.max(200, maxContextChars - used);
        parts.push(`${formatted.slice(0, remaining)}\n...[truncated to fit local context window]`);
        truncated = true;
        break;
      }
    }
    contextText = `\n\nAttached Local Vault Context:\n${parts.join('\n\n')}`;
  }

  const systemMessage = {
    role: 'system' as const,
    content: `${systemPrompt}${contextText}`,
  };

  let remainingBudget = Math.max(2000, maxChars - systemMessage.content.length);
  const selectedHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // Keep the most recent turns within the character budget
  const recentSlice = history.slice(-16);
  for (let i = recentSlice.length - 1; i >= 0; i--) {
    const msg = recentSlice[i];
    if (msg.content.length <= remainingBudget || selectedHistory.length === 0) {
      const content =
        msg.content.length <= remainingBudget
          ? msg.content
          : `${msg.content.slice(0, remainingBudget)}\n...[trimmed]`;
      if (content.length < msg.content.length) truncated = true;
      selectedHistory.unshift({ role: msg.role, content });
      remainingBudget -= content.length;
    } else {
      truncated = true;
      break;
    }
  }

  return {
    messages: [systemMessage, ...selectedHistory],
    truncated,
  };
}

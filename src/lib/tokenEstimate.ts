/**
 * Token estimation without a tokenizer dependency.
 *
 * Text is split into prose, code and CJK characters (each tokenises very differently), converted with
 * per-kind ratios, then scaled by a per-model calibration learned from the runtime's own token counts.
 * Budgets apply SAFETY_MARGIN on top so an under-estimate cannot overflow the context window.
 */

export const PROSE_CHARS_PER_TOKEN = 3.8;
export const CODE_CHARS_PER_TOKEN = 3.0;
/** Han / kana / hangul / full-width characters are roughly one token each. */
export const CJK_TOKENS_PER_CHAR = 1.1;
/** Chat-template overhead per message (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 8;
export const SAFETY_MARGIN = 1.1;

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

export interface TextProfile {
  prose: number;
  code: number;
  cjk: number;
}

/** Returns the fence token (e.g. "```") that is still open at the end of `text`, or null. */
export function openFenceAfter(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(FENCE_LINE_RE);
    if (!m) continue;
    const token = m[1];
    if (open === null) {
      open = token;
    } else if (token[0] === open[0] && token.length >= open.length && line.trim() === token) {
      open = null;
    }
  }
  return open;
}

export function profileText(text: string): TextProfile {
  const profile: TextProfile = { prose: 0, code: 0, cjk: 0 };
  if (!text) return profile;
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const fence = line.match(FENCE_LINE_RE);
    let isCode = open !== null;
    if (fence) {
      isCode = true;
      if (open === null) {
        open = fence[1];
      } else if (fence[1][0] === open[0] && fence[1].length >= open.length && line.trim() === fence[1]) {
        open = null;
      }
    }
    const cjkMatches = line.match(CJK_RE);
    const cjk = cjkMatches ? cjkMatches.length : 0;
    const rest = line.length - cjk + 1; // +1 for the newline
    profile.cjk += cjk;
    if (isCode) profile.code += rest;
    else profile.prose += rest;
  }
  return profile;
}

/** Raw token estimate (no safety margin). `scale` is the per-model calibration multiplier. */
export function estimateTokens(text: string, scale = 1): number {
  if (!text) return 0;
  const p = profileText(text);
  const raw = p.prose / PROSE_CHARS_PER_TOKEN + p.code / CODE_CHARS_PER_TOKEN + p.cjk * CJK_TOKENS_PER_CHAR;
  return Math.ceil(raw * scale);
}

/** Conservative estimate used for budgeting: raw estimate plus the safety margin. */
export function budgetTokens(text: string, scale = 1): number {
  return Math.ceil(estimateTokens(text, scale) * SAFETY_MARGIN);
}

export function estimateMessagesTokens(
  messages: Array<{ content: string }>,
  scale = 1,
  withMargin = false
): number {
  let total = 0;
  for (const m of messages) {
    total += (withMargin ? budgetTokens(m.content, scale) : estimateTokens(m.content, scale)) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Per-model calibration
// ---------------------------------------------------------------------------------------------

export interface TokenCalibration {
  /** Multiplier applied to the base estimate. >1 means the model tokenises denser than assumed. */
  scale: number;
  samples: number;
}

export const DEFAULT_CALIBRATION: TokenCalibration = { scale: 1, samples: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;

export interface CalibrationSample {
  /** Base estimate (scale = 1) for the same text. */
  estimatedTokens: number;
  /** Token count reported by the runtime. */
  observedTokens: number;
  /**
   * True for prompt-side samples. Runtimes that reuse a prompt cache report only the newly
   * evaluated tokens, which would look like "tokens are cheap". Such low readings are ignored so the
   * calibration can only drift toward the safe (over-estimating) side from prompt data.
   */
  promptSide?: boolean;
}

export function updateCalibration(cal: TokenCalibration, sample: CalibrationSample): TokenCalibration {
  const { estimatedTokens, observedTokens, promptSide } = sample;
  if (!(estimatedTokens > 8) || !(observedTokens > 0)) return cal;
  const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, observedTokens / estimatedTokens));
  if (promptSide && target < cal.scale * 0.85) return cal;
  const alpha = cal.samples < 3 ? 0.5 : 0.2;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cal.scale * (1 - alpha) + target * alpha));
  return { scale, samples: cal.samples + 1 };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const memoryCache = new Map<string, TokenCalibration>();
const storageKey = (model: string) => `gemmavault:tokcal:v1:${model}`;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function getCalibration(model: string, storage: StorageLike | null = defaultStorage()): TokenCalibration {
  const cached = memoryCache.get(model);
  if (cached) return cached;
  let cal = DEFAULT_CALIBRATION;
  try {
    const raw = storage?.getItem(storageKey(model));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TokenCalibration>;
      if (typeof parsed.scale === 'number' && Number.isFinite(parsed.scale)) {
        cal = {
          scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, parsed.scale)),
          samples: typeof parsed.samples === 'number' ? Math.min(1000, Math.max(0, parsed.samples)) : 0,
        };
      }
    }
  } catch {
    // corrupt or unavailable storage: fall back to defaults
  }
  memoryCache.set(model, cal);
  return cal;
}

export function recordCalibrationSample(
  model: string,
  sample: CalibrationSample,
  storage: StorageLike | null = defaultStorage()
): TokenCalibration {
  const next = updateCalibration(getCalibration(model, storage), sample);
  memoryCache.set(model, next);
  try {
    storage?.setItem(storageKey(model), JSON.stringify(next));
  } catch {
    // best effort only
  }
  return next;
}

/** Test helper: forget in-memory calibrations. */
export function resetCalibrationCache(): void {
  memoryCache.clear();
}

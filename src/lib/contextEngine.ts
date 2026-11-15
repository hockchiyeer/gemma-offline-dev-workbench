/**
 * Prompt construction for local models.
 *
 * Local runtimes (Ollama, llama.cpp) keep a KV cache of the prompt they last evaluated and only
 * process the part that changed. That only works if the start of every request is byte-identical to
 * the previous one, so this module builds an append-only transcript:
 *
 *   [system: static prompt (+ conversation summary, which changes rarely)]
 *   [user turn 1: attached context + question]   <- replayed exactly as sent, from ChatMessage.sentContext
 *   [assistant turn 1]
 *   [user turn 2: attached context + question]   <- only this part is new work for the runtime
 *
 * Volatile material (attachments) therefore lives in the *latest user message*, never the system
 * message. A token budget allocator keeps everything inside the context window, truncating only at
 * safe boundaries (whole turns, whole attachments, never inside a code fence), and a compaction
 * planner decides when the oldest turns should be folded into a summary instead of being dropped.
 */
import type { ChatMessage, ConversationSummary } from '../types/vault';
import { MESSAGE_OVERHEAD_TOKENS, budgetTokens, openFenceAfter } from './tokenEstimate';

export const CONTEXT_HEADER = 'Attached Local Vault Context:\n';
export const REQUEST_DELIMITER = '\n\n--- REQUEST ---\n';
export const TRUNCATION_NOTE = '\n...[truncated to fit local context window]';
export const TRIM_NOTE = '\n...[trimmed]';
export const SUMMARY_HEADER = '\n\nConversation summary (earlier turns were condensed to save context):\n';

/** Share of the prompt budget reserved for chat history / attached context when they compete. */
export const HISTORY_SHARE = 0.35;
export const CONTEXT_SHARE = 0.5;
/** Compact once replayable history exceeds this fraction of its share. */
export const COMPACT_TRIGGER = 0.6;
/** Most recent turns (user + reply pairs) kept verbatim when compacting. */
export const KEEP_RECENT_TURNS = 4;
/** Folding fewer tokens than this is not worth a model call. */
export const MIN_FOLD_TOKENS = 300;

const DEFAULT_INPUT_TOKENS = 7500;
const MIN_INPUT_TOKENS = 1024;
const MIN_BLOCK_TOKENS = 120;
const FOOTER_RESERVE_TOKENS = 48;

export interface ContextBlock {
  title: string;
  kind: string;
  content: string;
}

export type ContextBudget = number | { contextTokens?: number; reserveForReply?: number };

export interface BuildOptions {
  summary?: ConversationSummary | null;
  /** Per-model token calibration multiplier (see tokenEstimate.ts). */
  calibration?: { scale: number };
}

export interface ContextUsage {
  /** Tokens available for the prompt (context window minus the reply reservation). */
  inputBudget: number;
  systemTokens: number;
  /** Tokens of the older turns actually included. */
  historyTokens: number;
  /** Tokens all replayable older turns would need. */
  historyTokensAll: number;
  historyCap: number;
  /** Tokens of the attached-context pack in the latest message. */
  contextTokens: number;
  latestTokens: number;
  totalTokens: number;
  /** Older turns that did not fit and were left out. */
  droppedTurns: number;
  /** Older turns replayed without their attachment bodies to save room. */
  slimmedTurns: number;
  /** Titles of attachments left out entirely. */
  omittedContext: string[];
  summaryActive: boolean;
  trimmedLatest: boolean;
}

export interface BuiltGemmaPayload {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  truncated: boolean;
  /**
   * The attached-context text that went out with the latest user message ('' when none). Persist it
   * as ChatMessage.sentContext so later turns replay this turn identically.
   */
  sentContext: string;
  usage: ContextUsage;
}

/** The text a user message contributes to the prompt. Must be a pure function of the stored message. */
export function renderUserTurn(msg: Pick<ChatMessage, 'content' | 'sentContext'>): string {
  return msg.sentContext ? `${msg.sentContext}${REQUEST_DELIMITER}${msg.content}` : msg.content;
}

/**
 * Cuts `text` to at most `maxChars` at a line boundary where possible and closes any code fence the
 * cut left open, so a truncated attachment can never swallow the rest of the prompt as "code".
 */
export function truncateAtBoundary(text: string, maxChars: number, note = TRUNCATION_NOTE): string {
  if (text.length <= maxChars) return text;
  const limit = Math.max(0, maxChars);
  let cut = text.lastIndexOf('\n', limit);
  if (cut < limit * 0.5) cut = limit;
  let head = text.slice(0, cut).replace(/\s+$/, '');
  const open = openFenceAfter(head);
  if (open) head += `\n${open}`;
  return head + note;
}

/** Largest line-boundary truncation of `text` whose budgeted token count stays within `maxTokens`. */
export function fitToTokens(
  text: string,
  maxTokens: number,
  scale = 1,
  note = TRUNCATION_NOTE
): { text: string; truncated: boolean } {
  if (budgetTokens(text, scale) <= maxTokens) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  for (let i = 0; i < 24 && lo < hi; i++) {
    const mid = Math.ceil((lo + hi) / 2);
    if (budgetTokens(truncateAtBoundary(text, mid, note), scale) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return { text: truncateAtBoundary(text, lo, note), truncated: true };
}

export interface RenderedContextPack {
  text: string;
  truncated: boolean;
  omitted: string[];
}

/**
 * Renders attachments in priority order (the order given). Whole attachments are kept while they
 * fit; the first one that does not fit is truncated at a safe boundary (if enough room remains) and
 * every lower-priority one is omitted, with a footer naming what was left out.
 */
export function renderContextPack(blocks: ContextBlock[], maxTokens: number, scale = 1): RenderedContextPack {
  if (blocks.length === 0) return { text: '', truncated: false, omitted: [] };
  const tok = (t: string) => budgetTokens(t, scale);
  const formatted = blocks.map((b) => `--- ${b.kind.toUpperCase()}: ${b.title} ---\n${b.content}`);

  const everything = CONTEXT_HEADER + formatted.join('\n\n');
  if (tok(everything) <= maxTokens) return { text: everything, truncated: false, omitted: [] };

  let used = tok(CONTEXT_HEADER) + FOOTER_RESERVE_TOKENS;
  const parts: string[] = [];
  const omitted: string[] = [];
  let stopped = false;
  for (let i = 0; i < blocks.length; i++) {
    if (stopped) {
      omitted.push(blocks[i].title);
      continue;
    }
    const cost = tok(formatted[i]) + 2;
    if (used + cost <= maxTokens) {
      parts.push(formatted[i]);
      used += cost;
      continue;
    }
    stopped = true;
    const remaining = maxTokens - used - 2;
    if (remaining >= MIN_BLOCK_TOKENS) {
      parts.push(fitToTokens(formatted[i], remaining, scale).text);
    } else {
      omitted.push(blocks[i].title);
    }
  }
  let text = CONTEXT_HEADER + parts.join('\n\n');
  if (omitted.length > 0) {
    text += `${parts.length > 0 ? '\n\n' : ''}[omitted to fit local context window: ${omitted.join(', ')}]`;
  }
  return { text, truncated: true, omitted };
}

/** Prompt budget in tokens for a given budget option. */
export function inputBudgetTokens(budget?: ContextBudget): number {
  if (typeof budget === 'number') return Math.max(600, Math.floor(budget / 3.2));
  if (budget && typeof budget === 'object') {
    const ctx = budget.contextTokens ?? 8192;
    const reserve = budget.reserveForReply ?? 2048;
    return Math.max(MIN_INPUT_TOKENS, ctx - reserve);
  }
  return DEFAULT_INPUT_TOKENS;
}

// ---------------------------------------------------------------------------------------------
// History units and summary coverage
// ---------------------------------------------------------------------------------------------

type WireMessage = { role: 'user' | 'assistant'; content: string };

interface Unit {
  source: ChatMessage[];
  wire: WireMessage[];
  tokens: number;
  /**
   * The same turn with attached-context bodies replaced by a one-line marker. Used only when the full
   * turn does not fit: keeping what was asked and answered beats dropping the whole turn.
   */
  slim?: { wire: WireMessage[]; tokens: number };
}

/** Messages after the summary's coverage point; `active` is false when there is no usable summary. */
export function sliceAfterSummary(
  messages: ChatMessage[],
  summary?: ConversationSummary | null
): { messages: ChatMessage[]; active: boolean } {
  if (!summary || !summary.text.trim()) return { messages, active: false };
  const idx = messages.findIndex((m) => m.id === summary.coversUpToMessageId);
  if (idx < 0) return { messages, active: false }; // stale summary (covered message no longer exists)
  return { messages: messages.slice(idx + 1), active: true };
}

/**
 * Groups replayable messages into turns (user + reply). Empty reply placeholders and a leading
 * assistant greeting (UI text that precedes the first user message) are not replayed.
 */
function toUnits(messages: ChatMessage[], scale: number): Unit[] {
  const units: Unit[] = [];
  const make = (source: ChatMessage[]): Unit => {
    const wire = source.map<WireMessage>((m) => ({
      role: m.role,
      content: m.role === 'user' ? renderUserTurn(m) : m.content,
    }));
    const count = (w: WireMessage[]) =>
      w.reduce((n, x) => n + budgetTokens(x.content, scale) + MESSAGE_OVERHEAD_TOKENS, 0);
    const unit: Unit = { source, wire, tokens: count(wire) };
    if (source.some((m) => m.role === 'user' && m.sentContext)) {
      const slimWire = source.map<WireMessage>((m) => ({
        role: m.role,
        content: m.role === 'user' ? `${abbreviateSentContext(m.sentContext)}${m.content}` : m.content,
      }));
      unit.slim = { wire: slimWire, tokens: count(slimWire) };
    }
    return unit;
  };
  let seenUser = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      if (!m.content.trim() || !seenUser) continue;
      units.push(make([m]));
      continue;
    }
    seenUser = true;
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'assistant' && !messages[j].content.trim()) j++;
    if (j < messages.length && messages[j].role === 'assistant') {
      units.push(make([m, messages[j]]));
      i = j;
    } else {
      units.push(make([m]));
    }
  }
  return units;
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

/**
 * Builds the request messages. `history` must end with the user message being sent. Older turns are
 * replayed exactly as stored; `contextBlocks` are attached to the latest user message only.
 */
export function buildGemmaMessages(
  systemPrompt: string,
  history: ChatMessage[],
  contextBlocks: ContextBlock[],
  budget?: ContextBudget,
  options: BuildOptions = {}
): BuiltGemmaPayload {
  const scale = options.calibration?.scale ?? 1;
  const tok = (t: string) => budgetTokens(t, scale);
  const msgTok = (t: string) => tok(t) + MESSAGE_OVERHEAD_TOKENS;
  const inputTokens = inputBudgetTokens(budget);

  const latest = history.length > 0 ? history[history.length - 1] : undefined;
  const earlier = latest ? history.slice(0, -1) : [];
  const { messages: afterSummary, active: summaryActive } = sliceAfterSummary(earlier, options.summary);

  const systemText =
    summaryActive && options.summary ? `${systemPrompt}${SUMMARY_HEADER}${options.summary.text}` : systemPrompt;
  const systemMessage = { role: 'system' as const, content: systemText };
  const systemTokens = msgTok(systemText);

  const units = toUnits(afterSummary, scale);
  const historyNeeded = units.reduce((n, u) => n + u.tokens, 0);
  const historyCap = Math.floor(HISTORY_SHARE * inputTokens);
  const contextCap = Math.floor(CONTEXT_SHARE * inputTokens);

  const emptyUsage = (): ContextUsage => ({
    inputBudget: inputTokens,
    systemTokens,
    historyTokens: 0,
    historyTokensAll: historyNeeded,
    historyCap,
    contextTokens: 0,
    latestTokens: 0,
    totalTokens: systemTokens,
    droppedTurns: 0,
    slimmedTurns: 0,
    omittedContext: [],
    summaryActive,
    trimmedLatest: false,
  });

  if (!latest) {
    return { messages: [systemMessage], truncated: false, sentContext: '', usage: emptyUsage() };
  }

  // 1. The user's own message is always sent; only a message larger than the whole window is trimmed.
  const room = Math.max(512, inputTokens - systemTokens);
  let latestContent = latest.content;
  let trimmedLatest = false;
  if (msgTok(latestContent) > room) {
    latestContent = fitToTokens(latestContent, Math.max(64, room - MESSAGE_OVERHEAD_TOKENS), scale, TRIM_NOTE).text;
    trimmedLatest = true;
  }
  const latestTokens = msgTok(latestContent);
  const avail = Math.max(0, room - latestTokens);

  // 2. Split what is left between attached context and older turns. History is guaranteed up to its
  //    share, context up to its share; whichever needs less hands the remainder to the other.
  const wantsContext = latest.role === 'user' && contextBlocks.length > 0;
  const fullPack = wantsContext ? renderContextPack(contextBlocks, Number.POSITIVE_INFINITY, scale) : null;
  const contextNeeded = fullPack ? tok(fullPack.text) + tok(REQUEST_DELIMITER) : 0;
  const contextBudget = wantsContext
    ? Math.min(contextNeeded, contextCap, Math.max(0, avail - Math.min(historyNeeded, historyCap)))
    : 0;
  const pack =
    wantsContext && fullPack
      ? contextBudget >= contextNeeded
        ? fullPack
        : renderContextPack(contextBlocks, contextBudget, scale)
      : { text: '', truncated: false, omitted: [] as string[] };
  const packTokens = pack.text ? tok(pack.text) + tok(REQUEST_DELIMITER) : 0;

  // 3. Older turns: newest first, whole turns only, contiguous (never a gap in the middle).
  const historyBudget = Math.min(historyNeeded, Math.max(0, avail - packTokens));
  const chosen: WireMessage[][] = [];
  let historyUsed = 0;
  let slimmedTurns = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (historyUsed + u.tokens <= historyBudget) {
      chosen.unshift(u.wire);
      historyUsed += u.tokens;
    } else if (u.slim && historyUsed + u.slim.tokens <= historyBudget) {
      chosen.unshift(u.slim.wire);
      historyUsed += u.slim.tokens;
      slimmedTurns++;
    } else {
      break;
    }
  }
  const droppedTurns = units.length - chosen.length;

  const latestWireContent =
    latest.role === 'user' && pack.text
      ? renderUserTurn({ sentContext: pack.text, content: latestContent })
      : latestContent;

  return {
    messages: [
      systemMessage,
      ...chosen.flat(),
      { role: latest.role, content: latestWireContent },
    ],
    truncated: pack.truncated || trimmedLatest || droppedTurns > 0 || slimmedTurns > 0,
    sentContext: pack.text,
    usage: {
      inputBudget: inputTokens,
      systemTokens,
      historyTokens: historyUsed,
      historyTokensAll: historyNeeded,
      historyCap,
      contextTokens: packTokens,
      latestTokens,
      totalTokens: systemTokens + historyUsed + packTokens + latestTokens,
      droppedTurns,
      slimmedTurns,
      omittedContext: pack.omitted,
      summaryActive,
      trimmedLatest,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Compaction planning
// ---------------------------------------------------------------------------------------------

export interface CompactionPlan {
  /** Messages to fold into the summary, oldest first. */
  fold: ChatMessage[];
  /** Becomes ConversationSummary.coversUpToMessageId. */
  coversUpToMessageId: string;
  foldTokens: number;
  /** Recent turns that stay verbatim. */
  keptTurns: number;
}

/**
 * Decides whether (and what) to fold into the summary. `earlier` is every message before the one
 * about to be sent. Returns null when the chat is still comfortably within its history budget.
 */
export function planCompaction(
  earlier: ChatMessage[],
  summary: ConversationSummary | null | undefined,
  inputTokens: number,
  scale = 1,
  opts: { force?: boolean } = {}
): CompactionPlan | null {
  const { messages } = sliceAfterSummary(earlier, summary);
  const units = toUnits(messages, scale);
  if (units.length < 2) return null;

  const historyCap = Math.floor(HISTORY_SHARE * inputTokens);
  const total = units.reduce((n, u) => n + u.tokens, 0);
  if (!opts.force && total <= COMPACT_TRIGGER * historyCap) return null;

  // Keep as many recent turns (up to KEEP_RECENT_TURNS) as fit in half the history share; at least one.
  let keep = 1;
  for (let k = Math.min(KEEP_RECENT_TURNS, units.length - 1); k >= 1; k--) {
    const tokens = units.slice(units.length - k).reduce((n, u) => n + u.tokens, 0);
    if (tokens <= 0.5 * historyCap) {
      keep = k;
      break;
    }
  }

  const foldUnits = units.slice(0, units.length - keep);
  const foldTokens = foldUnits.reduce((n, u) => n + u.tokens, 0);
  if (foldUnits.length === 0) return null;
  if (!opts.force && foldTokens < MIN_FOLD_TOKENS) return null;

  const fold = foldUnits.flatMap((u) => u.source);
  return {
    fold,
    coversUpToMessageId: fold[fold.length - 1].id,
    foldTokens,
    keptTurns: keep,
  };
}

/** Compact one-line description of an attached-context pack, for summarisation transcripts. */
export function abbreviateSentContext(sentContext?: string): string {
  if (!sentContext) return '';
  const heads: string[] = [];
  for (const line of sentContext.split('\n')) {
    const m = line.match(/^--- (.+) ---$/);
    if (m) heads.push(m[1]);
  }
  return heads.length > 0 ? `[attached: ${heads.join('; ')}] ` : '';
}

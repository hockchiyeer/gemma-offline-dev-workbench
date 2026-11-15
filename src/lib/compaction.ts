/**
 * Folds the oldest turns of a chat into a short rolling "memory note" using the same local model,
 * so long sessions keep their decisions and code facts instead of silently losing old turns.
 */
import type { ChatMessage, ConversationSummary, LocalRuntimeConfig } from '../types/vault';
import { abbreviateSentContext, truncateAtBoundary } from './contextEngine';
import { streamLocalGemmaChat } from './gemmaClient';
import { budgetTokens, MESSAGE_OVERHEAD_TOKENS } from './tokenEstimate';

export const MAX_SUMMARY_CHARS = 3200;
const MAX_FOLD_MESSAGE_CHARS = 2400;
const MAX_CHUNKS = 6;
const SUMMARY_REPLY_TOKENS = 700;

export const COMPACTION_SYSTEM_PROMPT = [
  'You maintain a running memory note for a coding conversation between a developer and an AI assistant.',
  'Merge the PRIOR NOTE (may be empty) and the NEW TRANSCRIPT into one updated note of at most 350 words,',
  'using exactly these sections:',
  '## Goal',
  '## Decisions & constraints',
  '## Code & files (exact names, signatures, versions, key facts)',
  '## Open issues',
  'Keep identifiers and numbers exact. Drop greetings and small talk. Do not invent anything.',
  'Output only the note.',
].join('\n');

export function renderForSummary(msg: ChatMessage): string {
  const body = truncateAtBoundary(msg.content, MAX_FOLD_MESSAGE_CHARS, '\n...[cut]');
  if (msg.role === 'user') return `[user] ${abbreviateSentContext(msg.sentContext)}${body}`;
  return `[assistant] ${body}`;
}

/** Greedy chunks of rendered messages that each fit `allowanceTokens`. */
export function chunkForSummary(rendered: string[], allowanceTokens: number, scale = 1): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const text of rendered) {
    const cost = budgetTokens(text, scale) + MESSAGE_OVERHEAD_TOKENS;
    if (current.length > 0 && used + cost > allowanceTokens) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(text);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function cleanSummary(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  return truncateAtBoundary(text, MAX_SUMMARY_CHARS, '\n...[cut]');
}

export interface CompactOptions {
  config: LocalRuntimeConfig;
  previous?: ConversationSummary | null;
  /** Messages to fold in, oldest first. */
  messages: ChatMessage[];
  signal: AbortSignal;
  transportHint?: 'direct' | 'proxy' | 'none';
  calibrationScale?: number;
}

async function summarizeOnce(
  config: LocalRuntimeConfig,
  priorNote: string,
  transcript: string,
  signal: AbortSignal,
  transportHint?: 'direct' | 'proxy' | 'none'
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: COMPACTION_SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: `PRIOR NOTE:\n${priorNote.trim() || '(none)'}\n\nNEW TRANSCRIPT:\n${transcript}`,
    },
  ];
  const run = (reasoning: 'off' | 'auto') =>
    streamLocalGemmaChat({
      config: {
        ...config,
        reasoning,
        temperature: 0.1,
        maxTokens: config.kind === 'openai' ? SUMMARY_REPLY_TOKENS * 2 : SUMMARY_REPLY_TOKENS,
      },
      messages,
      transportHint,
      signal,
      onToken: () => {},
    });
  try {
    return await run('off');
  } catch (err) {
    // Some builds only answer with reasoning on; retry once that way. Never retry a user abort.
    if (signal.aborted) throw err;
    if (err instanceof Error && /empty answer with Reasoning turned off/i.test(err.message)) {
      return run('auto');
    }
    throw err;
  }
}

/** Returns the updated summary text (prior note merged with the folded messages). */
export async function compactConversation(opts: CompactOptions): Promise<string> {
  const { config, previous, messages, signal, transportHint } = opts;
  const scale = opts.calibrationScale ?? 1;
  const ctx = config.contextTokens ?? 8192;
  const prior = previous?.text ?? '';
  // Room for the transcript = window - instructions - prior note - the reply.
  const allowance = Math.max(
    600,
    ctx - SUMMARY_REPLY_TOKENS - 450 - budgetTokens(prior, scale) - (config.kind === 'openai' ? SUMMARY_REPLY_TOKENS : 0)
  );
  const chunks = chunkForSummary(messages.map(renderForSummary), allowance, scale);
  if (chunks.length === 0) throw new Error('Nothing to summarise.');
  if (chunks.length > MAX_CHUNKS) {
    throw new Error('This conversation is too long to condense automatically with the current context window.');
  }

  let note = prior;
  for (const chunk of chunks) {
    const out = cleanSummary(await summarizeOnce(config, note, chunk.join('\n\n'), signal, transportHint));
    if (!out) throw new Error('The model returned an empty summary.');
    note = out;
  }
  return note;
}

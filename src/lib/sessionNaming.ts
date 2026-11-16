import { CODING_STARTERS } from './codingStarters';
import type { ChatAttachmentRef, SnippetActionKind } from '../types/vault';

const MAX_TITLE_LEN = 46;

const DEFAULT_TITLE_RE = /^New Coding Session(?:\s+\d+)?$/i;
const VERSION_PREFIX_RE = /^v\d+\s+[A-Za-z]+\s*·\s*/;

const ACTION_VERB: Record<SnippetActionKind, string> = {
  chat: 'Chat',
  explain: 'Explain',
  debug: 'Debug',
  refactor: 'Refactor',
  expand: 'Expand',
  'unit-tests': 'Test',
  edit: 'Edit',
};

const BOILERPLATE_ACTION_RES: Array<{ verb: string; re: RegExp }> = [
  { verb: 'Explain', re: /^explain\s+how\s+(?:this|the)\s+(?:code\s+)?snippet\s+works/i },
  { verb: 'Debug', re: /^(?:find\s+potential\s+bugs|debug\s+(?:this|the)\s+(?:code\s+)?snippet)/i },
  { verb: 'Refactor', re: /^refactor\s+(?:this|the)\s+(?:code\s+)?snippet/i },
  { verb: 'Test', re: /^write\s+(?:comprehensive\s+)?unit\s+tests\s+for\s+(?:this|the)\s+(?:code\s+)?snippet/i },
  { verb: 'Expand', re: /^expand\s+(?:this|the)\s+(?:code\s+)?snippet/i },
  { verb: 'Edit', re: /^(?:propose\s+targeted\s+edits|edit\s+(?:this|the)\s+(?:code\s+)?snippet)/i },
];

const TRAILING_STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with',
]);

export function clampSessionTitle(raw: string, maxLen = MAX_TITLE_LEN): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Coding Discussion';
  if (clean.length <= maxLen) return clean;

  const slice = clean.slice(0, maxLen - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const boundary = lastSpace >= Math.floor(maxLen * 0.45) ? slice.slice(0, lastSpace) : slice;
  const words = boundary.replace(/[,:;.\-–—]+$/, '').trim().split(/\s+/);
  while (words.length > 2 && TRAILING_STOPWORDS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  const finalText = words.join(' ').replace(/[,:;.\-–—]+$/, '').trim();
  return `${finalText || slice.trim()}…`;
}

export function cleanAttachmentLabel(att: ChatAttachmentRef): string {
  let title = att.title.trim();
  if (att.kind === 'snippet') {
    title = title.replace(VERSION_PREFIX_RE, '').trim();
  }
  return title || att.id;
}

export function isDefaultSessionTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (trimmed.toLowerCase() === 'gemma local coding session') return true;
  return DEFAULT_TITLE_RE.test(trimmed);
}

export function nextDefaultSessionTitle(existingSessions: Array<{ title: string }>): string {
  const taken = new Set(existingSessions.map((s) => s.title.trim().toLowerCase()));
  if (!taken.has('new coding session')) return 'New Coding Session';
  let n = 2;
  while (taken.has(`new coding session ${n}`)) n++;
  return `New Coding Session ${n}`;
}

function stripLeadingFiller(text: string): string {
  let out = text.trim();
  const filler =
    /^(?:please|can you|could you|would you|help me|i want(?: you)? to|i need(?: you)? to|show me how to|show how to|tell me how to|walk(?: me)? through)\s+/i;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(filler, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

export function deriveSessionTitle(input: {
  prompt: string;
  attachments?: ChatAttachmentRef[];
  actionKind?: SnippetActionKind;
  starterLabel?: string;
}): string {
  const rawPrompt = input.prompt.trim();
  const primaryAtt = input.attachments?.[0];

  // 1. Exact or prefix match against a Coding Task Starter card
  if (input.starterLabel) {
    return clampSessionTitle(input.starterLabel);
  }
  const matchedStarter = CODING_STARTERS.find(
    (s) => rawPrompt === s.prompt || rawPrompt.startsWith(s.prompt)
  );
  if (matchedStarter) {
    return clampSessionTitle(matchedStarter.label);
  }

  // 2. Boilerplate snippet/code quick action with an attached snippet or file
  if (primaryAtt) {
    const attName = cleanAttachmentLabel(primaryAtt);
    for (const { verb, re } of BOILERPLATE_ACTION_RES) {
      if (re.test(rawPrompt) && rawPrompt.length < 140) {
        return clampSessionTitle(`${verb}: ${attName}`);
      }
    }
  }

  // 3. Clean freeform prompt into a crisp topic title
  let cleaned = rawPrompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/@(?:snippet|file|folder|symbol|doc|git):[^\s]+/gi, ' ')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Take only the first sentence/line if multi-sentence so titles stay focused
  const firstBreak = cleaned.search(/[.\n?!](?:\s|$)/);
  if (firstBreak > 14) {
    cleaned = cleaned.slice(0, firstBreak).trim();
  }

  cleaned = stripLeadingFiller(cleaned);

  if (!cleaned && primaryAtt) {
    const verb = input.actionKind ? ACTION_VERB[input.actionKind] : '';
    const attName = cleanAttachmentLabel(primaryAtt);
    return clampSessionTitle(verb && verb !== 'Chat' ? `${verb}: ${attName}` : attName);
  }

  if (!cleaned) return 'Coding Discussion';

  // Replace vague "this snippet" / "this code" when we know the attachment name
  if (primaryAtt && /\bthis\s+(?:code\s+)?(?:snippet|file|code)\b/i.test(cleaned)) {
    const attShort = clampSessionTitle(cleanAttachmentLabel(primaryAtt), 22).replace(/…$/, '');
    const withTarget = cleaned.replace(/\bthis\s+(?:code\s+)?(?:snippet|file|code)\b/i, attShort);
    return clampSessionTitle(capitalizeFirst(withTarget));
  }

  return clampSessionTitle(capitalizeFirst(cleaned));
}

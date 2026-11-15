/**
 * Turns a model reply into a reviewable edit proposal and back into prompts.
 *
 * A proposal is stored on the assistant message (EditProposal) and is deliberately *not* a computed
 * result: matching is redone against the snippet's current code whenever the card renders, so a
 * proposal stays correct (or visibly fails to match) even if the snippet changed in the meantime.
 */
import type { ContextBlock } from './contextEngine';
import { hashText, parseEditBlocks, planHunks, type MatchFailure } from './editEngine';
import type { EditProposal, EditTarget } from '../types/vault';

/** Automatic follow-ups after a reply whose blocks did not match (further retries are manual). */
export const MAX_AUTO_REPAIRS = 1;

export const EDIT_FORMAT_INSTRUCTIONS = [
  'EDIT MODE. Propose changes as SEARCH/REPLACE blocks that a tool will apply to the attached snippet(s).',
  '',
  'Block format (one per change):',
  '<snippet title exactly as in its header, without the language in parentheses>',
  '<<<<<<< SEARCH',
  '<existing lines, copied exactly, including indentation>',
  '=======',
  '<new lines>',
  '>>>>>>> REPLACE',
  '',
  'Rules:',
  '- SEARCH must match the current code character for character. Do not paraphrase or abbreviate it.',
  '- Include just enough surrounding lines to make the match unique. Keep each block small.',
  '- Use several blocks for several changes. Never repeat an unchanged part of the file.',
  '- To delete lines, leave the REPLACE section empty. To insert, quote a nearby line in SEARCH and repeat it in REPLACE with the new lines.',
  '- Put a one or two sentence explanation before the blocks. Do not return the whole file.',
  '',
  'Example:',
  'utils.ts',
  '<<<<<<< SEARCH',
  'function add(a, b) {',
  '  return a - b;',
  '}',
  '=======',
  'function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '>>>>>>> REPLACE',
].join('\n');

/** Attached as the first context block of an edit turn (so it travels with the message, not the system prompt). */
export const EDIT_INSTRUCTION_BLOCK: ContextBlock = {
  title: 'Edit format',
  kind: 'instructions',
  content: EDIT_FORMAT_INSTRUCTIONS,
};

export interface SnippetLike {
  id: string;
  title: string;
  code: string;
}

/** Strips the "(language)" suffix the context header adds, for lenient title matching. */
function stripLang(s: string): string {
  return s.replace(/\s*\([a-z+#]+\)\s*$/i, '').trim();
}

/**
 * Maps the label a model wrote above a block to one of the attached snippets: exact title, then
 * case-insensitive, then containment either way. Returns undefined when nothing (or more than one
 * snippet) fits.
 */
export function resolveTarget(label: string | undefined, candidates: Array<{ id: string; title: string }>): string | undefined {
  if (!label) return undefined;
  const want = stripLang(label);
  const lower = want.toLowerCase();
  const exact = candidates.find((c) => c.title === want);
  if (exact) return exact.id;
  const ci = candidates.filter((c) => c.title.toLowerCase() === lower);
  if (ci.length === 1) return ci[0].id;
  const partial = candidates.filter((c) => {
    const t = c.title.toLowerCase();
    return t.includes(lower) || lower.includes(t);
  });
  return partial.length === 1 ? partial[0].id : undefined;
}

export interface BuildProposalInput {
  reply: string;
  snippets: SnippetLike[];
  attempt?: number;
}

/**
 * Reads SEARCH/REPLACE blocks out of `reply`. Returns null when the reply contains none (and no
 * malformed ones), so the caller can fall back to its normal handling.
 */
export function buildProposalFromReply({ reply, snippets, attempt = 0 }: BuildProposalInput): EditProposal | null {
  const { blocks, errors } = parseEditBlocks(reply);
  if (blocks.length === 0 && errors.length === 0) return null;

  const issues = [...errors];
  const byTarget = new Map<string, EditTarget>();
  let counter = 0;

  for (const block of blocks) {
    let id = resolveTarget(block.target, snippets);
    if (!id && snippets.length === 1) id = snippets[0].id;
    if (!id) {
      issues.push(
        block.target
          ? `Could not tell which snippet "${block.target}" refers to (edit block at line ${block.line}).`
          : `An edit block at line ${block.line} did not say which snippet it changes.`
      );
      continue;
    }
    const snippet = snippets.find((s) => s.id === id)!;
    let target = byTarget.get(id);
    if (!target) {
      target = {
        snippetId: id,
        title: snippet.title,
        baseHash: hashText(snippet.code),
        hunks: [],
        state: 'pending',
      };
      byTarget.set(id, target);
    }
    counter++;
    target.hunks.push({ id: `h${counter}`, search: block.search, replace: block.replace });
  }

  if (byTarget.size === 0 && issues.length === 0) return null;
  return { targets: [...byTarget.values()], issues, attempt };
}

export interface FailedHunk {
  snippetId: string;
  title: string;
  hunkId: string;
  search: string;
  failure: MatchFailure;
}

/** Hunks of still-pending targets that cannot be located in the snippets' current code. */
export function findFailedHunks(proposal: EditProposal, snippets: SnippetLike[]): FailedHunk[] {
  const out: FailedHunk[] = [];
  for (const target of proposal.targets) {
    if (target.state !== 'pending') continue;
    const snippet = snippets.find((s) => s.id === target.snippetId);
    if (!snippet) continue;
    const plan = planHunks(snippet.code, target.hunks);
    for (const o of plan.outcomes) {
      if (o.result.ok) continue;
      const hunk = target.hunks.find((h) => h.id === o.hunkId)!;
      out.push({ snippetId: target.snippetId, title: target.title, hunkId: o.hunkId, search: hunk.search, failure: o.result });
    }
  }
  return out;
}

const preview = (s: string, max = 90) => {
  const first = s.split('\n').find((l) => l.trim() !== '') ?? '';
  const t = first.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** Follow-up asking the model to re-send only the blocks that failed, quoting the current code exactly. */
export function buildRepairPrompt(failures: FailedHunk[]): string {
  const lines = [
    'Some of your SEARCH/REPLACE blocks could not be applied because their SEARCH text does not match the current code.',
    'Re-send ONLY those blocks, copying the SEARCH lines exactly from the attached snippet (the attachment is the current version).',
    '',
    'Failed blocks:',
  ];
  failures.forEach((f, i) => {
    const hint = f.failure.reason === 'not-found' && f.failure.closest ? ` Closest region: lines ${f.failure.closest.start + 1}-${f.failure.closest.end}.` : '';
    lines.push(`${i + 1}. ${f.title}: ${f.failure.detail}${hint} The SEARCH began with: ${preview(f.search)}`);
  });
  return lines.join('\n');
}

/**
 * The follow-up to send for a proposal that did not fully work: failed matches and/or malformed
 * blocks. Returns null when there is nothing to repair.
 */
export function repairPromptFor(proposal: EditProposal, snippets: SnippetLike[]): string | null {
  const failures = findFailedHunks(proposal, snippets);
  if (failures.length === 0 && proposal.issues.length === 0) return null;
  const parts: string[] = [];
  if (failures.length > 0) parts.push(buildRepairPrompt(failures));
  if (proposal.issues.length > 0) {
    parts.push(
      [
        'Problems with the edit format in your previous reply:',
        ...proposal.issues.map((i) => `- ${i}`),
        'Re-send the affected changes as complete blocks: a title line, <<<<<<< SEARCH, =======, then >>>>>>> REPLACE.',
      ].join('\n')
    );
  }
  return parts.join('\n\n');
}

/** Whether Undo is still safe: the snippet is exactly as the edit left it. */
export function canUndo(target: EditTarget, currentCode: string | undefined): boolean {
  return target.state === 'applied' && target.preImage !== undefined && currentCode !== undefined && hashText(currentCode) === target.postHash;
}

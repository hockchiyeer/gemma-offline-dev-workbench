import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, FilePenLine, GitBranch, Undo2 } from 'lucide-react';
import { DiffView } from './DiffView';
import {
  applyHunks,
  compareSyntax,
  diffLines,
  diffStats,
  hashText,
  planHunks,
  type HunkMatch,
} from '../lib/editEngine';
import { canUndo, findFailedHunks } from '../lib/editProposal';
import type { CodeSnippet, EditProposal, EditTarget } from '../types/vault';

export interface ApplyEditArgs {
  newCode: string;
  /** Hash of the snippet code the preview was computed from; the app refuses if it changed since. */
  expectedHash: string;
  acceptedHunkIds: string[];
}

export interface SaveVersionArgs {
  newCode: string;
  acceptedHunkIds: string[];
}

interface EditProposalCardProps {
  proposal: EditProposal;
  /** Current snippets; edits are always matched against these, not against what the model saw. */
  snippets: CodeSnippet[];
  /** Disables actions while a reply is streaming or something is being saved. */
  busy: boolean;
  onApply: (targetIndex: number, args: ApplyEditArgs) => void | Promise<void>;
  onSaveVersion: (targetIndex: number, args: SaveVersionArgs) => void | Promise<void>;
  onUndo: (targetIndex: number) => void | Promise<void>;
  onDismiss: (targetIndex: number) => void;
  /** Ask the model to re-send the blocks that did not match. */
  onRepair?: () => void;
  onOpenSnippet?: (snippetId: string) => void;
}

const CONTEXT_LINES = 2;

function strategyLabel(m: HunkMatch): string {
  if (m.strategy === 'exact') return 'exact match';
  if (m.strategy === 'whitespace') return 'matched ignoring whitespace';
  return `approximate match (${Math.round(m.score * 100)}%) - check it`;
}

interface TargetReviewProps {
  target: EditTarget;
  index: number;
  snippet?: CodeSnippet;
  busy: boolean;
  onApply: EditProposalCardProps['onApply'];
  onSaveVersion: EditProposalCardProps['onSaveVersion'];
  onUndo: EditProposalCardProps['onUndo'];
  onDismiss: EditProposalCardProps['onDismiss'];
  onOpenSnippet?: EditProposalCardProps['onOpenSnippet'];
}

const TargetReview: React.FC<TargetReviewProps> = ({
  target,
  index,
  snippet,
  busy,
  onApply,
  onSaveVersion,
  onUndo,
  onDismiss,
  onOpenSnippet,
}) => {
  const [deselected, setDeselected] = useState<Record<string, boolean>>({});
  const pending = target.state === 'pending' && !!snippet;
  const code = snippet?.code ?? '';

  const plan = useMemo(() => (pending ? planHunks(code, target.hunks) : null), [pending, code, target.hunks]);
  const acceptedIds = useMemo(
    () => (plan ? plan.outcomes.filter((o) => o.result.ok && !deselected[o.hunkId]).map((o) => o.hunkId) : []),
    [plan, deselected]
  );
  const result = useMemo(
    () => (pending ? applyHunks(code, target.hunks, new Set(acceptedIds)) : null),
    [pending, code, target.hunks, acceptedIds]
  );
  const stats = useMemo(
    () => (result && result.changed ? diffStats(diffLines(code, result.text)) : { added: 0, removed: 0 }),
    [result, code]
  );
  const syntax = useMemo(
    () => (result && result.changed && snippet ? compareSyntax(code, result.text, snippet.language) : null),
    [result, code, snippet]
  );

  const shell = 'rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs dark:border-slate-800 dark:bg-slate-950/50';

  if (target.state === 'dismissed') {
    return (
      <div className={`${shell} text-slate-500 dark:text-slate-400`}>
        Dismissed the proposed edits to <span className="font-medium">{target.title}</span>.
      </div>
    );
  }

  if (target.state === 'saved') {
    return (
      <div className={`${shell} flex flex-wrap items-center gap-2 text-slate-700 dark:text-slate-300`}>
        <GitBranch className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        <span>
          Saved {target.acceptedHunkIds?.length ?? 0} change{(target.acceptedHunkIds?.length ?? 0) === 1 ? '' : 's'} to{' '}
          <span className="font-medium">{target.title}</span> as a new version.
        </span>
        {target.resultSnippetId && onOpenSnippet && (
          <button
            type="button"
            onClick={() => onOpenSnippet(target.resultSnippetId!)}
            className="font-medium text-teal-700 hover:underline dark:text-teal-400"
          >
            Open it
          </button>
        )}
      </div>
    );
  }

  if (target.state === 'applied') {
    const undoable = canUndo(target, snippet?.code);
    return (
      <div className={`${shell} flex flex-wrap items-center gap-2 text-slate-700 dark:text-slate-300`}>
        <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        <span>
          Applied {target.acceptedHunkIds?.length ?? 0} change{(target.acceptedHunkIds?.length ?? 0) === 1 ? '' : 's'} to{' '}
          <span className="font-medium">{target.title}</span>.
        </span>
        <button
          type="button"
          disabled={!undoable || busy}
          onClick={() => void onUndo(index)}
          title={undoable ? 'Restore the snippet to how it was before this edit' : 'The snippet was changed after this edit, so it cannot be undone automatically'}
          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-slate-300 px-2.5 font-medium hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
          Undo
        </button>
        {!undoable && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">The snippet changed since, so Undo is unavailable.</span>
        )}
      </div>
    );
  }

  // Pending.
  if (!snippet || !plan || !result) {
    return (
      <div className={`${shell} flex flex-wrap items-center gap-2 text-amber-800 dark:text-amber-300`}>
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          The snippet <span className="font-medium">{target.title}</span> no longer exists, so these edits cannot be applied.
        </span>
        <button type="button" onClick={() => onDismiss(index)} className="font-medium underline">
          Dismiss
        </button>
      </div>
    );
  }

  const stale = hashText(code) !== target.baseHash;
  const failedCount = plan.outcomes.filter((o) => !o.result.ok).length;
  const skippedByHunk = new Map(result.skipped.map((s) => [s.hunkId, s.reason]));
  const canAct = result.applied.length > 0 && !busy;

  return (
    <section className={shell} aria-label={`Proposed edits to ${target.title}`}>
      <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <FilePenLine className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        <h4 className="font-semibold text-slate-900 dark:text-slate-100">{target.title}</h4>
        <span className="text-slate-500 dark:text-slate-400">
          {target.hunks.length} proposed change{target.hunks.length === 1 ? '' : 's'}
        </span>
        {result.changed && (
          <span className="ml-auto font-mono tabular-nums">
            <span className="text-emerald-700 dark:text-emerald-400">+{stats.added}</span>{' '}
            <span className="text-red-700 dark:text-red-400">−{stats.removed}</span>
          </span>
        )}
      </header>

      {stale && (
        <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-amber-800 dark:text-amber-300">
          This snippet changed after the edits were proposed. Each change below was re-located in the current code.
        </p>
      )}

      <ol className="space-y-2.5">
        {target.hunks.map((hunk, n) => {
          const outcome = plan.outcomes.find((o) => o.hunkId === hunk.id)!;
          const res = outcome.result;
          if (!res.ok) {
            return (
              <li key={hunk.id} className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
                <p className="font-medium text-red-800 dark:text-red-300">Change {n + 1} cannot be applied</p>
                <p className="mt-0.5 text-slate-700 dark:text-slate-300">{res.detail}</p>
                <details className="mt-1.5">
                  <summary className="cursor-pointer select-none text-slate-500 dark:text-slate-400">Show the text the model tried to match</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre rounded-md bg-slate-100 p-2 font-mono text-[11px] dark:bg-slate-900">{hunk.search}</pre>
                </details>
              </li>
            );
          }
          const m = res.match;
          const ctxStart = Math.max(0, m.start - CONTEXT_LINES);
          const ctxEnd = Math.min(plan.lines.length, m.end + CONTEXT_LINES);
          const before = plan.lines.slice(ctxStart, ctxEnd).join('\n');
          const after = [...plan.lines.slice(ctxStart, m.start), ...m.replacement, ...plan.lines.slice(m.end, ctxEnd)].join('\n');
          const selected = !deselected[hunk.id];
          const skipNote = selected ? skippedByHunk.get(hunk.id) : undefined;
          return (
            <li key={hunk.id} className="space-y-1.5">
              <label className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(e) => setDeselected((d) => ({ ...d, [hunk.id]: !e.target.checked }))}
                  className="h-4 w-4 accent-teal-600"
                  aria-label={`Apply change ${n + 1}`}
                />
                <span className="font-medium text-slate-800 dark:text-slate-200">Change {n + 1}</span>
                <span className="text-slate-500 dark:text-slate-400">
                  lines {m.start + 1}–{m.end} · {strategyLabel(m)}
                </span>
              </label>
              {skipNote && selected && (
                <p className="flex items-center gap-1 text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {skipNote} It will be skipped.
                </p>
              )}
              <DiffView
                ops={diffLines(before, after)}
                context={CONTEXT_LINES}
                lineOffset={ctxStart}
                label={`Change ${n + 1} to ${target.title}`}
              />
            </li>
          );
        })}
      </ol>

      {syntax && syntax.introduced.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-amber-800 dark:text-amber-300" role="alert">
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            This result may not be valid {snippet.language} code
          </p>
          <ul className="mt-0.5 list-disc pl-5">
            {syntax.introduced.slice(0, 3).map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
          <p className="mt-0.5 text-[11px] opacity-80">A quick bracket and string check, not a compiler; it only reports problems the original did not have.</p>
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canAct}
          onClick={() => void onSaveVersion(index, { newCode: result.text, acceptedHunkIds: result.applied })}
          title="Keep the original and save the edited code as a new child version"
          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-teal-600 px-3 font-medium text-white hover:bg-teal-500 disabled:opacity-40"
        >
          <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
          Save as new version
        </button>
        <button
          type="button"
          disabled={!canAct}
          onClick={() => void onApply(index, { newCode: result.text, expectedHash: hashText(code), acceptedHunkIds: result.applied })}
          title="Overwrite this snippet with the edited code (you can undo)"
          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-slate-300 px-3 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Apply to original
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDismiss(index)}
          className="min-h-[36px] rounded-lg px-3 font-medium text-slate-500 hover:underline disabled:opacity-40 dark:text-slate-400"
        >
          Dismiss
        </button>
        {failedCount > 0 && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {failedCount} change{failedCount === 1 ? '' : 's'} could not be located and will not be applied.
          </span>
        )}
      </footer>
    </section>
  );
};

export const EditProposalCard: React.FC<EditProposalCardProps> = ({
  proposal,
  snippets,
  busy,
  onApply,
  onSaveVersion,
  onUndo,
  onDismiss,
  onRepair,
  onOpenSnippet,
}) => {
  const failed = useMemo(() => findFailedHunks(proposal, snippets), [proposal, snippets]);

  return (
    <div className="mt-3 space-y-2.5 border-t border-slate-200/80 pt-3 dark:border-slate-800/80">
      {proposal.attempt > 0 && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">Follow-up attempt {proposal.attempt}: re-sent blocks that did not match before.</p>
      )}
      {proposal.issues.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300" role="alert">
          {proposal.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {proposal.targets.map((target, i) => (
        <TargetReview
          key={`${target.snippetId}-${i}`}
          target={target}
          index={i}
          snippet={snippets.find((s) => s.id === target.snippetId)}
          busy={busy}
          onApply={onApply}
          onSaveVersion={onSaveVersion}
          onUndo={onUndo}
          onDismiss={onDismiss}
          onOpenSnippet={onOpenSnippet}
        />
      ))}
      {onRepair && (failed.length > 0 || proposal.issues.length > 0) && (
        <button
          type="button"
          disabled={busy}
          onClick={onRepair}
          className="min-h-[34px] rounded-lg border border-teal-600/40 bg-teal-500/10 px-3 text-xs font-medium text-teal-800 hover:bg-teal-500/20 disabled:opacity-40 dark:text-teal-300"
        >
          Ask Gemma to fix the failed {failed.length > 0 ? `change${failed.length === 1 ? '' : 's'}` : 'blocks'}
        </button>
      )}
    </div>
  );
};

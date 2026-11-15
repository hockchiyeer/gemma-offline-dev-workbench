import React, { useEffect, useState } from 'react';
import { FoldVertical, Gauge, Loader2, ScrollText } from 'lucide-react';
import type { ContextUsage } from '../lib/contextEngine';
import type { ConversationSummary, GenerationStats } from '../types/vault';

interface ContextBarProps {
  usage: ContextUsage | null;
  lastStats?: GenerationStats;
  summary?: ConversationSummary;
  streaming: boolean;
  compacting: boolean;
  onCompactNow: () => void;
  onCancelCompaction: () => void;
  onSaveSummary: (text: string) => void;
  onClearSummary: () => void;
}

const formatTokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export const ContextBar: React.FC<ContextBarProps> = ({
  usage,
  lastStats,
  summary,
  streaming,
  compacting,
  onCompactNow,
  onCancelCompaction,
  onSaveSummary,
  onClearSummary,
}) => {
  const [showSummary, setShowSummary] = useState(false);
  const [draft, setDraft] = useState(summary?.text ?? '');

  useEffect(() => {
    setDraft(summary?.text ?? '');
  }, [summary?.text, summary?.updatedAt]);

  useEffect(() => {
    if (!summary) setShowSummary(false);
  }, [summary]);

  if (!usage) return null;

  const pct = Math.min(100, Math.round((usage.totalTokens / Math.max(1, usage.inputBudget)) * 100));
  const tone = pct >= 95 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-teal-500';
  const busy = streaming || compacting;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        <span
          className="inline-flex items-center gap-1.5 tabular-nums"
          title="Estimated prompt size against what fits in the context window after reserving room for the reply."
        >
          <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Context ≈ {formatTokens(usage.totalTokens)} / {formatTokens(usage.inputBudget)} tokens
        </span>
        <span
          className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Context window usage"
        >
          <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </span>

        {usage.droppedTurns > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            {usage.droppedTurns} older turn{usage.droppedTurns === 1 ? '' : 's'} won't fit
          </span>
        )}
        {usage.slimmedTurns > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            {usage.slimmedTurns} earlier attachment{usage.slimmedTurns === 1 ? '' : 's'} shortened
          </span>
        )}
        {usage.omittedContext.length > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            {usage.omittedContext.length} attachment{usage.omittedContext.length === 1 ? '' : 's'} left out
          </span>
        )}

        {lastStats?.tokensPerSecond ? (
          <span className="tabular-nums" title="Speed of the last reply as measured by the local runtime">
            {lastStats.tokensPerSecond} tok/s
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-3">
          {summary && (
            <button
              type="button"
              onClick={() => setShowSummary((v) => !v)}
              aria-expanded={showSummary}
              className="inline-flex min-h-[28px] items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-400"
            >
              <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
              Summary
            </button>
          )}
          {compacting ? (
            <button
              type="button"
              onClick={onCancelCompaction}
              className="inline-flex min-h-[28px] items-center gap-1 font-medium text-slate-600 hover:underline dark:text-slate-300"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Condensing… (stop)
            </button>
          ) : (
            <button
              type="button"
              onClick={onCompactNow}
              disabled={busy}
              className="inline-flex min-h-[28px] items-center gap-1 font-medium text-slate-600 hover:underline disabled:opacity-40 dark:text-slate-300"
              title="Condense older turns into a short summary to free up context"
            >
              <FoldVertical className="h-3.5 w-3.5" aria-hidden="true" />
              Condense chat
            </button>
          )}
        </span>
      </div>

      {summary && showSummary && (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-900/70">
          <p className="leading-snug text-slate-600 dark:text-slate-400">
            Older turns were condensed into this note, which is sent to the model in their place. Edit it to correct
            or add facts. Changing it makes the model re-read the conversation once on the next message.
          </p>
          <textarea
            aria-label="Conversation summary"
            rows={8}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="max-h-72 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] leading-relaxed text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || draft.trim() === summary.text.trim() || !draft.trim()}
              onClick={() => onSaveSummary(draft)}
              className="min-h-[32px] rounded-lg bg-teal-600 px-3 font-medium text-white hover:bg-teal-500 disabled:opacity-40"
            >
              Save changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClearSummary}
              className="min-h-[32px] rounded-lg border border-slate-300 px-3 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              title="Remove the summary and send the older turns again in full (as far as they fit)"
            >
              Remove summary
            </button>
            <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
              {summary.edited ? 'Edited by you' : summary.model ? `Written by ${summary.model}` : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

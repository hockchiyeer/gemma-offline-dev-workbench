import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import type { RuntimeStatus, RuntimeTone } from '../lib/runtimeStatus';

interface RuntimeStatusBarProps {
  status: RuntimeStatus;
  refreshing: boolean;
  lastCheckedAt: number | null;
  onRecheck: () => void;
  onOpenSettings: () => void;
}

const TONE_STYLES: Record<RuntimeTone, { bar: string; icon: string }> = {
  ok: {
    bar: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  warn: {
    bar: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  bad: {
    bar: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100',
    icon: 'text-red-600 dark:text-red-400',
  },
  busy: {
    bar: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-100',
    icon: 'text-sky-600 dark:text-sky-400',
  },
  neutral: {
    bar: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300',
    icon: 'text-slate-500 dark:text-slate-400',
  },
};

function StatusIcon({ tone }: { tone: RuntimeTone }) {
  const cls = 'h-4 w-4 shrink-0';
  if (tone === 'ok') return <CheckCircle2 className={cls} aria-hidden="true" />;
  if (tone === 'bad') return <XCircle className={cls} aria-hidden="true" />;
  if (tone === 'warn') return <AlertTriangle className={cls} aria-hidden="true" />;
  return <Loader2 className={`${cls} motion-safe:animate-spin`} aria-hidden="true" />;
}

/**
 * Always-visible answer to "is only the web page up, or is the local LLM up too?".
 * Colour is never the only signal: every state has an icon and a text headline.
 */
export const RuntimeStatusBar: React.FC<RuntimeStatusBarProps> = ({
  status,
  refreshing,
  lastCheckedAt,
  onRecheck,
  onOpenSettings,
}) => {
  const styles = TONE_STYLES[status.tone];
  const pct =
    typeof status.percent === 'number'
      ? Math.max(0, Math.min(100, Math.round(status.percent)))
      : null;
  const needsAction = status.tone === 'bad' || status.tone === 'warn';
  const checkedText = lastCheckedAt
    ? `Last checked ${new Date(lastCheckedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}`
    : 'Not checked yet';

  return (
    <div
      data-testid="runtime-status"
      data-level={status.level}
      role="status"
      aria-live="polite"
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs sm:px-6 ${styles.bar}`}
    >
      <span className={styles.icon}>
        <StatusIcon tone={status.tone} />
      </span>
      <div className="min-w-0 flex-1" title={`${status.label}. ${status.detail} ${checkedText}`}>
        <span className="font-semibold">{status.label}</span>
        {pct !== null && <span className="ml-1.5 font-mono tabular-nums">{pct}%</span>}
        <span className="ml-2 hidden opacity-80 sm:inline">{status.detail}</span>
        <span className="mt-0.5 block opacity-80 sm:hidden">{status.detail}</span>
        {pct !== null && (
          <span
            className="mt-1 block h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full bg-sky-500 transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onRecheck}
        disabled={refreshing}
        aria-label="Re-check local LLM now"
        title={checkedText}
        className="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-lg hover:bg-black/5 disabled:opacity-60 lg:min-h-[32px] lg:min-w-[32px] pointer-coarse:min-h-[40px] pointer-coarse:min-w-[40px] dark:hover:bg-white/10"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${refreshing ? 'motion-safe:animate-spin' : ''}`}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        className={`min-h-[40px] shrink-0 rounded-lg px-3 text-xs font-semibold lg:min-h-[32px] pointer-coarse:min-h-[40px] ${
          needsAction
            ? 'bg-slate-900 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200'
            : 'border border-current/20 hover:bg-black/5 dark:hover:bg-white/10'
        }`}
      >
        {needsAction ? 'Fix / set up' : 'Runtime'}
      </button>
    </div>
  );
};

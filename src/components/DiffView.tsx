import React, { useMemo } from 'react';
import { collapseContext, type DiffOp } from '../lib/editEngine';

interface DiffViewProps {
  ops: DiffOp[];
  /** Unchanged lines shown around each change. */
  context?: number;
  /** Added to the old/new line numbers (for diffs of a fragment that starts part-way into a file). */
  lineOffset?: number;
  /** Rows beyond this are not rendered (keeps huge diffs from freezing the page). */
  maxRows?: number;
  label: string;
}

const ROW_STYLE: Record<DiffOp['type'], string> = {
  add: 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-300',
  del: 'bg-red-500/10 text-red-900 dark:text-red-300',
  eq: 'text-slate-600 dark:text-slate-400',
};

const MARK: Record<DiffOp['type'], string> = { add: '+', del: '−', eq: ' ' };

export const DiffView: React.FC<DiffViewProps> = ({ ops, context = 3, lineOffset = 0, maxRows = 400, label }) => {
  const rows = useMemo(() => collapseContext(ops, context), [ops, context]);
  const shown = rows.slice(0, maxRows);
  const hidden = rows.length - shown.length;
  const hasChanges = ops.some((o) => o.type !== 'eq');

  if (!hasChanges) {
    return <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">No changes.</p>;
  }

  return (
    <div
      role="group"
      aria-label={label}
      className="overflow-x-auto rounded-lg border border-slate-200 bg-white font-mono text-[11px] leading-relaxed dark:border-slate-800 dark:bg-slate-950"
    >
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((row, i) =>
            row.type === 'gap' ? (
              <tr key={`g${i}`} className="bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-500">
                <td colSpan={4} className="px-3 py-0.5 text-center text-[10px]">
                  ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
                </td>
              </tr>
            ) : (
              <tr key={i} className={ROW_STYLE[row.type]}>
                <td className="w-9 select-none px-1.5 text-right tabular-nums text-slate-400 dark:text-slate-600">
                  {row.aLine !== undefined ? row.aLine + lineOffset : ''}
                </td>
                <td className="w-9 select-none px-1.5 text-right tabular-nums text-slate-400 dark:text-slate-600">
                  {row.bLine !== undefined ? row.bLine + lineOffset : ''}
                </td>
                <td className="w-4 select-none text-center" aria-hidden="true">
                  {MARK[row.type]}
                </td>
                <td className="whitespace-pre pr-3">
                  <span className="sr-only">{row.type === 'add' ? 'added: ' : row.type === 'del' ? 'removed: ' : ''}</span>
                  {row.text === '' ? ' ' : row.text}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
      {hidden > 0 && (
        <p className="border-t border-slate-200 px-3 py-1 text-center text-[10px] text-slate-500 dark:border-slate-800">
          … {hidden} more row{hidden === 1 ? '' : 's'} not shown
        </p>
      )}
    </div>
  );
};

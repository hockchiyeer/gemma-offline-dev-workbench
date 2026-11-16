import React from 'react';
import { BookOpen, Code2, FileCode2, Folder, GitBranch, Hash, Loader2 } from 'lucide-react';
import type { MentionCandidate } from '../lib/workspaceContext';

export function mentionOptionId(idPrefix: string, index: number): string {
  return `${idPrefix}-opt-${index}`;
}

interface MentionPopupProps {
  candidates: MentionCandidate[];
  activeIndex: number;
  loading: boolean;
  idPrefix: string;
  onSelect: (candidate: MentionCandidate) => void;
  onHover: (index: number) => void;
}

const CategoryIcon: React.FC<{ category: MentionCandidate['category'] }> = ({ category }) => {
  switch (category) {
    case 'File':
      return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden="true" />;
    case 'Folder':
      return <Folder className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
    case 'Symbol':
      return <Hash className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />;
    case 'Git':
      return <GitBranch className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />;
    case 'Snippet':
      return <Code2 className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />;
    case 'Doc':
      return <BookOpen className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />;
  }
};

export const MentionPopup: React.FC<MentionPopupProps> = ({
  candidates,
  activeIndex,
  loading,
  idPrefix,
  onSelect,
  onHover,
}) => {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200/80 px-3 py-1.5 text-[11px] font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <span>Attach project file, symbol, git context, snippet or doc</span>
        {loading && (
          <span className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-400">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Searching
          </span>
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400">
          {loading ? 'Searching project index…' : 'No matching files or snippets.'}
        </div>
      ) : (
        <ul
          id={`${idPrefix}-list`}
          role="listbox"
          aria-label="Mention suggestions"
          className="max-h-56 overflow-y-auto py-1"
        >
          {candidates.map((c, idx) => {
            const active = idx === activeIndex;
            return (
              <li key={c.key} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={mentionOptionId(idPrefix, idx)}
                  aria-selected={active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(c);
                  }}
                  onMouseEnter={() => onHover(idx)}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
                    active
                      ? 'bg-teal-500/15 text-slate-950 dark:bg-teal-500/20 dark:text-white'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <CategoryIcon category={c.category} />
                  <span className="min-w-0 flex-1 truncate font-mono font-medium">
                    {c.label}
                  </span>
                  <span className="shrink-0 truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {c.detail}
                  </span>
                  <span className="w-12 shrink-0 text-right text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    {c.category}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

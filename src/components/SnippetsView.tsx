import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { analyzeCodeLocally, SUPPORTED_LANGUAGES } from '../lib/syntax';
import type { CodeSnippet, Project, SupportedLanguage } from '../types/vault';
import { CodeBlock } from './CodeBlock';
import { useConfirm } from './ConfirmDialog';

interface SnippetsViewProps {
  snippets: CodeSnippet[];
  projects: Project[];
  activeProjectId: string;
  onSaveSnippet: (snippet: CodeSnippet) => void | Promise<void>;
  onDeleteSnippet: (id: string) => Promise<void>;
  onSendToGemma: (snippet: CodeSnippet, actionPrompt: string) => void;
}

export const SnippetsView: React.FC<SnippetsViewProps> = ({
  snippets,
  projects,
  activeProjectId,
  onSaveSnippet,
  onDeleteSnippet,
  onSendToGemma,
}) => {
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [langFilter, setLangFilter] = useState<'all' | SupportedLanguage>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(snippets[0]?.id || null);
  const [mobileEditing, setMobileEditing] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');
  const [copied, setCopied] = useState(false);
  const [tagInput, setTagInput] = useState('');

  const filteredSnippets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return snippets.filter((s) => {
      if (activeProjectId !== 'all' && s.projectId !== activeProjectId) return false;
      if (langFilter !== 'all' && s.language !== langFilter) return false;
      if (favoritesOnly && !s.favorite) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.notes.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [snippets, activeProjectId, langFilter, favoritesOnly, search]);

  const activeSnippet = useMemo(
    () =>
      filteredSnippets.find((s) => s.id === selectedId) ||
      snippets.find((s) => s.id === selectedId) ||
      filteredSnippets[0] ||
      null,
    [filteredSnippets, snippets, selectedId]
  );

  const metrics = useMemo(
    () => (activeSnippet ? analyzeCodeLocally(activeSnippet.code) : null),
    [activeSnippet]
  );

  const handleCreate = async () => {
    const now = Date.now();
    const targetProject =
      activeProjectId !== 'all' ? activeProjectId : projects[0]?.id || 'proj-core';
    const created: CodeSnippet = {
      id: `snip-${crypto.randomUUID()}`,
      projectId: targetProject,
      title: 'Untitled Code Snippet',
      language: 'typescript',
      code: '// Write or paste code here\n',
      notes: '',
      tags: [],
      favorite: false,
      createdAt: now,
      updatedAt: now,
    };
    await onSaveSnippet(created);
    setSelectedId(created.id);
    setViewMode('edit');
    setMobileEditing(true);
  };

  const handleUpdate = (patch: Partial<CodeSnippet>) => {
    if (!activeSnippet) return;
    void onSaveSnippet({
      ...activeSnippet,
      ...patch,
      updatedAt: Date.now(),
    });
  };

  const handleDeleteCurrent = async () => {
    if (!activeSnippet) return;
    const accepted = await confirm({
      title: 'Delete Code Snippet',
      message: `Remove "${activeSnippet.title}" permanently from your local database?`,
      confirmLabel: 'Delete Snippet',
      destructive: true,
    });
    if (!accepted) return;
    const idToDelete = activeSnippet.id;
    await onDeleteSnippet(idToDelete);
    setSelectedId(null);
    setMobileEditing(false);
  };

  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSnippet) return;
    const clean = tagInput.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (clean && !activeSnippet.tags.includes(clean)) {
      handleUpdate({ tags: [...activeSnippet.tags, clean] });
    }
    setTagInput('');
  };

  const handleCopyCode = async () => {
    if (!activeSnippet) return;
    try {
      await navigator.clipboard.writeText(activeSnippet.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore
    }
  };

  const handleDownloadFile = () => {
    if (!activeSnippet) return;
    const meta = SUPPORTED_LANGUAGES.find((l) => l.id === activeSnippet.language);
    const ext = meta?.extension || 'txt';
    const safeName =
      activeSnippet.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'snippet';
    const blob = new Blob([activeSnippet.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Left List Pane */}
      <aside
        className={`flex w-full flex-col border-b border-slate-200 bg-white lg:w-80 lg:shrink-0 lg:border-r lg:border-b-0 xl:w-96 dark:border-slate-800 dark:bg-slate-900/70 ${
          mobileEditing ? 'hidden lg:flex' : 'flex flex-1 lg:flex-initial'
        }`}
      >
        <div className="space-y-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Code Snippets
            </h2>
            <button
              type="button"
              onClick={handleCreate}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-500 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              New Snippet
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, code, or tags..."
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 pr-3 pl-9 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div className="flex items-center gap-2">
            <select
              aria-label="Filter by language"
              value={langFilter}
              onChange={(e) => setLangFilter(e.target.value as 'all' | SupportedLanguage)}
              className="min-h-[40px] lg:min-h-[38px] pointer-coarse:min-h-[40px] flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs text-slate-700 outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
            >
              <option value="all">All Languages</option>
              {SUPPORTED_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setFavoritesOnly((v) => !v)}
              className={`inline-flex min-h-[40px] lg:min-h-[38px] pointer-coarse:min-h-[40px] items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                favoritesOnly
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-slate-200 bg-slate-50 text-slate-600 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <Star className={`h-3.5 w-3.5 ${favoritesOnly ? 'fill-current' : ''}`} />
              Starred
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-200/80 dark:divide-slate-800/80">
          {filteredSnippets.length === 0 ? (
            <div className="p-6 text-center">
              <Code2 className="mx-auto h-8 w-8 text-slate-400" />
              <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                No matching snippets
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Adjust filters or save a new code block into your encrypted local database.
              </p>
              <button
                type="button"
                onClick={handleCreate}
                className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Plus className="h-3.5 w-3.5" />
                Create First Snippet
              </button>
            </div>
          ) : (
            filteredSnippets.map((item) => {
              const isSelected = activeSnippet?.id === item.id;
              const lineCount = item.code.split('\n').length;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id);
                    setMobileEditing(true);
                  }}
                  className={`block w-full px-4 py-3.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-teal-50/70 dark:bg-teal-950/25'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {item.title}
                    </span>
                    {item.favorite && (
                      <Star className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" />
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-mono text-teal-700 dark:text-teal-400">
                      {item.language}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{lineCount} lines</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatTime(item.updatedAt)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Right Editor / Inspector */}
      <section
        className={`flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-[#0B1120] ${
          mobileEditing ? 'flex' : 'hidden lg:flex'
        }`}
      >
        {activeSnippet ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMobileEditing(false)}
                  aria-label="Back to snippets list"
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 text-slate-600 lg:hidden dark:border-slate-800 dark:text-slate-300"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <input
                  type="text"
                  value={activeSnippet.title}
                  onChange={(e) => handleUpdate({ title: e.target.value })}
                  aria-label="Snippet title"
                  className="min-w-0 flex-1 bg-transparent text-base font-semibold text-slate-900 outline-none focus:underline dark:text-white"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
                  <button
                    type="button"
                    onClick={() => setViewMode('edit')}
                    className={`inline-flex min-h-[40px] lg:min-h-[34px] pointer-coarse:min-h-[40px] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${
                      viewMode === 'edit'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('preview')}
                    className={`inline-flex min-h-[40px] lg:min-h-[34px] pointer-coarse:min-h-[40px] items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${
                      viewMode === 'preview'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Highlight
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => handleUpdate({ favorite: !activeSnippet.favorite })}
                  aria-label={activeSnippet.favorite ? 'Remove star' : 'Star snippet'}
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Star
                    className={`h-4 w-4 ${
                      activeSnippet.favorite ? 'fill-amber-500 text-amber-500' : ''
                    }`}
                  />
                </button>

                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </button>

                <button
                  type="button"
                  onClick={handleDownloadFile}
                  aria-label="Download snippet file"
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Download className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={handleDeleteCurrent}
                  aria-label="Delete snippet"
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 bg-white text-red-600 hover:bg-red-50 dark:border-slate-800 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/60 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/30">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Snippet language"
                  value={activeSnippet.language}
                  onChange={(e) =>
                    handleUpdate({ language: e.target.value as SupportedLanguage })
                  }
                  className="min-h-[40px] lg:min-h-[36px] pointer-coarse:min-h-[40px] rounded-lg border border-slate-200 bg-white px-2.5 font-mono text-xs text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                >
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Snippet project"
                  value={activeSnippet.projectId}
                  onChange={(e) => handleUpdate({ projectId: e.target.value })}
                  className="min-h-[40px] lg:min-h-[36px] pointer-coarse:min-h-[40px] rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                {metrics && (
                  <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {metrics.lines} lines · {metrics.characters} chars ·{' '}
                    {metrics.bracketsBalanced ? 'Brackets balanced' : 'Unclosed brackets'}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { label: 'Explain', prompt: 'Explain how this snippet works step-by-step and note any edge cases.' },
                  { label: 'Debug', prompt: 'Audit this snippet for potential bugs, race conditions, or security flaws and provide a fixed version.' },
                  { label: 'Refactor', prompt: 'Refactor this snippet for clarity, modularity, and idiomatic best practices.' },
                  { label: 'Unit Tests', prompt: 'Write comprehensive unit tests covering normal cases and boundary conditions for this code.' },
                ].map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => onSendToGemma(activeSnippet, action.prompt)}
                    className="inline-flex min-h-[40px] lg:min-h-[34px] pointer-coarse:min-h-[40px] items-center gap-1 rounded-lg border border-teal-600/30 bg-teal-500/10 px-2.5 text-xs font-medium text-teal-700 transition-colors hover:bg-teal-500/20 whitespace-nowrap shrink-0 dark:text-teal-300"
                  >
                    <Sparkles className="h-3 w-3" />
                    {action.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {viewMode === 'edit' ? (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0D1424]">
                  <textarea
                    value={activeSnippet.code}
                    onChange={(e) => handleUpdate({ code: e.target.value })}
                    spellCheck={false}
                    aria-label="Code editor"
                    rows={18}
                    className="block min-h-[340px] w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-6 text-slate-900 outline-none dark:text-slate-100"
                  />
                </div>
              ) : (
                <CodeBlock
                  code={activeSnippet.code}
                  language={activeSnippet.language}
                  showLineNumbers
                />
              )}

              <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-900/60">
                <div>
                  <label
                    htmlFor="snippet-notes"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Engineering Notes
                  </label>
                  <textarea
                    id="snippet-notes"
                    rows={3}
                    value={activeSnippet.notes}
                    onChange={(e) => handleUpdate({ notes: e.target.value })}
                    placeholder="Usage constraints, complexity notes, or dependencies..."
                    className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-800 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
                  />
                </div>

                <div>
                  <label
                    htmlFor="snippet-tag-input"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Tags & Extracted Symbols
                  </label>
                  <form onSubmit={handleAddTag} className="mt-1.5 flex gap-2">
                    <input
                      id="snippet-tag-input"
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Add tag (e.g. auth)"
                      className="min-h-[40px] lg:min-h-[38px] pointer-coarse:min-h-[40px] flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                    />
                    <button
                      type="submit"
                      className="min-h-[40px] lg:min-h-[38px] pointer-coarse:min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      Add
                    </button>
                  </form>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                    {activeSnippet.tags.length === 0 ? (
                      <span>No tags assigned</span>
                    ) : (
                      activeSnippet.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() =>
                            handleUpdate({
                              tags: activeSnippet.tags.filter((t) => t !== tag),
                            })
                          }
                          title="Click to remove tag"
                          className="font-mono hover:text-red-600 dark:hover:text-red-400"
                        >
                          #{tag} ×
                        </button>
                      ))
                    )}
                  </div>

                  {metrics && metrics.symbols.length > 0 && (
                    <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Symbols: <span className="font-mono">{metrics.symbols.join(', ')}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <Code2 className="mx-auto h-10 w-10 text-slate-400" />
              <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-300">
                Select or create a snippet to edit
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

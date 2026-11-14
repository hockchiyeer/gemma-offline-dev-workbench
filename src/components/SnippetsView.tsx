import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  CornerDownRight,
  Download,
  Eye,
  GitBranch,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import {
  buildSnippetTree,
  formatActionLabel,
} from '../lib/snippetLineage';
import { analyzeCodeLocally, SUPPORTED_LANGUAGES } from '../lib/syntax';
import type {
  CodeSnippet,
  Project,
  SnippetActionKind,
  SupportedLanguage,
} from '../types/vault';
import { CodeBlock } from './CodeBlock';
import { useConfirm } from './ConfirmDialog';

interface SnippetsViewProps {
  snippets: CodeSnippet[];
  projects: Project[];
  activeProjectId: string;
  selectedSnippetId?: string | null;
  onSelectSnippet?: (id: string | null) => void;
  mobileOpenNonce?: number;
  onSaveSnippet: (snippet: CodeSnippet) => void | Promise<void>;
  onDeleteSnippet: (id: string) => Promise<void>;
  onSendToGemma: (
    snippet: CodeSnippet,
    actionPrompt: string,
    actionKind?: SnippetActionKind
  ) => void;
  onMobileDetailChange?: (active: boolean) => void;
}

export const SnippetsView: React.FC<SnippetsViewProps> = ({
  snippets,
  projects,
  activeProjectId,
  selectedSnippetId,
  onSelectSnippet,
  mobileOpenNonce,
  onSaveSnippet,
  onDeleteSnippet,
  onSendToGemma,
  onMobileDetailChange,
}) => {
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [langFilter, setLangFilter] = useState<'all' | SupportedLanguage>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    snippets[0]?.id || null
  );
  const resolvedSelectedId =
    selectedSnippetId !== undefined ? selectedSnippetId : internalSelectedId;
  const setSelectedId = (id: string | null) => {
    setInternalSelectedId(id);
    onSelectSnippet?.(id);
  };
  const [mobileEditing, setMobileEditing] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');
  const [copied, setCopied] = useState(false);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (mobileOpenNonce && mobileOpenNonce > 0) {
      setMobileEditing(true);
    }
  }, [mobileOpenNonce]);

  useEffect(() => {
    onMobileDetailChange?.(mobileEditing);
    return () => onMobileDetailChange?.(false);
  }, [mobileEditing, onMobileDetailChange]);

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

  const snippetTree = useMemo(
    () => buildSnippetTree(filteredSnippets, snippets),
    [filteredSnippets, snippets]
  );

  const activeSnippet = useMemo(
    () =>
      filteredSnippets.find((s) => s.id === resolvedSelectedId) ||
      snippets.find((s) => s.id === resolvedSelectedId) ||
      snippetTree[0]?.snippet ||
      filteredSnippets[0] ||
      null,
    [filteredSnippets, snippets, snippetTree, resolvedSelectedId]
  );

  const parentSnippet = useMemo(
    () =>
      activeSnippet?.parentId
        ? snippets.find((s) => s.id === activeSnippet.parentId) || null
        : null,
    [snippets, activeSnippet]
  );

  const derivedChildren = useMemo(() => {
    if (!activeSnippet) return [];
    return snippets
      .filter((s) => s.parentId === activeSnippet.id)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [snippets, activeSnippet]);

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
      version: 1,
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
    const fallbackNextId = activeSnippet.parentId || null;
    await onDeleteSnippet(idToDelete);
    setSelectedId(fallbackNextId);
    if (!fallbackNextId) {
      setMobileEditing(false);
    }
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
          {snippetTree.length === 0 ? (
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
            snippetTree.map(({ snippet: item, depth, childCount, parentTitle }) => {
              const isSelected = activeSnippet?.id === item.id;
              const lineCount = item.code.split('\n').length;
              const cappedDepth = Math.min(depth, 4);
              const paddingLeftPx = cappedDepth > 0 ? 16 + cappedDepth * 14 : 16;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id);
                    setMobileEditing(true);
                  }}
                  style={cappedDepth > 0 ? { paddingLeft: `${paddingLeftPx}px` } : undefined}
                  className={`relative block w-full py-3 pr-4 pl-4 text-left transition-colors ${
                    isSelected
                      ? 'bg-teal-50/70 dark:bg-teal-950/25'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  {cappedDepth > 0 && (
                    <span
                      aria-hidden="true"
                      style={{ left: `${paddingLeftPx - 10}px` }}
                      className="absolute top-0 bottom-0 w-px bg-slate-200 dark:bg-slate-800"
                    />
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                      {depth > 0 && (
                        <CornerDownRight
                          className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{item.title}</span>
                    </span>
                    {item.favorite && (
                      <Star className="h-3.5 w-3.5 shrink-0 fill-amber-500 text-amber-500" />
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {(item.version || item.derivedAction) && (
                      <>
                        <span className="font-mono text-slate-700 dark:text-slate-300">
                          v{item.version ?? 1}
                          {item.derivedAction ? ` · ${formatActionLabel(item.derivedAction)}` : ''}
                        </span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span className="font-mono text-teal-700 dark:text-teal-400">
                      {item.language}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{lineCount} lines</span>
                    {childCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums text-teal-700 dark:text-teal-400">
                          {childCount} {childCount === 1 ? 'child' : 'children'}
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{formatTime(item.updatedAt)}</span>
                  </div>
                  {depth === 0 && parentTitle && (
                    <div className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400">
                      from {parentTitle}
                    </div>
                  )}
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-4 sm:py-2.5 lg:flex-nowrap dark:border-slate-800 dark:bg-slate-900/60">
              <div className="order-1 flex min-w-0 flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMobileEditing(false)}
                  aria-label="Back to snippets list"
                  className="flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 lg:hidden dark:border-slate-800 dark:text-slate-300"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <input
                  type="text"
                  value={activeSnippet.title}
                  onChange={(e) => handleUpdate({ title: e.target.value })}
                  aria-label="Snippet title"
                  title="Click to modify code snippet name"
                  placeholder="Untitled Code Snippet"
                  className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none focus:underline sm:text-base dark:text-white"
                />
              </div>

              <div className="order-2 flex shrink-0 items-center gap-1.5 lg:order-3">
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

              <div className="order-3 flex w-full items-center justify-between gap-1.5 lg:order-2 lg:w-auto lg:justify-start lg:gap-2">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
                    <button
                      type="button"
                      onClick={() => setViewMode('edit')}
                      title="Enable modification of code snippet's name and code"
                      aria-label="Edit — enable modification of code snippet's name and code"
                      className={`inline-flex min-h-[40px] lg:min-h-[34px] pointer-coarse:min-h-[40px] items-center gap-1.5 rounded-md px-2 sm:px-2.5 text-xs font-medium whitespace-nowrap ${
                        viewMode === 'edit'
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('preview')}
                      title="View syntax-highlighted code preview"
                      aria-label="Highlight — view syntax-highlighted code preview"
                      className={`inline-flex min-h-[40px] lg:min-h-[34px] pointer-coarse:min-h-[40px] items-center gap-1.5 rounded-md px-2 sm:px-2.5 text-xs font-medium whitespace-nowrap ${
                        viewMode === 'preview'
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      Highlight
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleCopyCode}
                    className="inline-flex min-h-[40px] lg:min-h-[36px] pointer-coarse:min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 sm:px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setMobileToolsOpen((v) => !v)}
                  aria-expanded={mobileToolsOpen}
                  aria-controls="snippet-tools-drawer"
                  className={`inline-flex min-h-[40px] items-center gap-1 rounded-lg border px-2 sm:px-2.5 text-xs font-medium whitespace-nowrap shrink-0 md:hidden ${
                    mobileToolsOpen
                      ? 'border-teal-600/40 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200'
                  }`}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>
                    Tools<span className="hidden min-[390px]:inline"> &amp; AI</span>
                  </span>
                  {mobileToolsOpen ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <div
              id="snippet-tools-drawer"
              className={`${
                mobileToolsOpen ? 'flex' : 'hidden md:flex'
              } flex-wrap items-center justify-between gap-2.5 border-b border-slate-200 bg-white/60 px-3 py-2.5 sm:px-4 dark:border-slate-800 dark:bg-slate-900/30`}
            >
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
                  {
                    kind: 'explain' as SnippetActionKind,
                    label: 'Explain',
                    title: 'Explain how this snippet works step-by-step',
                    prompt: 'Explain how this snippet works step-by-step and note any edge cases.',
                  },
                  {
                    kind: 'debug' as SnippetActionKind,
                    label: 'Debug',
                    title: 'Audit for bugs, race conditions, or security issues',
                    prompt: 'Audit this snippet for potential bugs, race conditions, or security flaws and provide a fixed version.',
                  },
                  {
                    kind: 'refactor' as SnippetActionKind,
                    label: 'Refactor',
                    title: 'Refactor for clarity and best practices',
                    prompt: 'Refactor this snippet for clarity, modularity, and idiomatic best practices.',
                  },
                  {
                    kind: 'expand' as SnippetActionKind,
                    label: 'Expand',
                    title: 'Implement new features, finish stubs, or expand code from comments and templates',
                    prompt: 'Implement or expand this snippet based on any comments, TODOs, or starter template. Complete unfinished logic into clean, idiomatic code with sensible edge-case handling.',
                  },
                  {
                    kind: 'unit-tests' as SnippetActionKind,
                    label: 'Unit Tests',
                    title: 'Generate unit tests for normal and edge cases',
                    prompt: 'Write comprehensive unit tests covering normal cases and boundary conditions for this code.',
                  },
                ].map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => onSendToGemma(activeSnippet, action.prompt, action.kind)}
                    title={action.title}
                    className="inline-flex min-h-[40px] lg:min-h-[34px] pointer-coarse:min-h-[40px] items-center gap-1 rounded-lg border border-teal-600/30 bg-teal-500/10 px-2.5 text-xs font-medium text-teal-700 transition-colors hover:bg-teal-500/20 whitespace-nowrap shrink-0 dark:text-teal-300"
                  >
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    {action.label}
                  </button>
                ))}
              </div>
            </div>

            {(parentSnippet || derivedChildren.length > 0) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white/40 px-3 py-1.5 text-xs text-slate-600 sm:px-4 dark:border-slate-800 dark:bg-slate-900/20 dark:text-slate-400">
                <span className="inline-flex items-center gap-1 font-mono text-slate-700 dark:text-slate-300">
                  <GitBranch className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
                  v{activeSnippet.version ?? 1}
                  {activeSnippet.derivedAction
                    ? ` · ${formatActionLabel(activeSnippet.derivedAction)}`
                    : ''}
                </span>
                {parentSnippet && (
                  <button
                    type="button"
                    onClick={() => setSelectedId(parentSnippet.id)}
                    className="truncate font-medium text-teal-700 hover:underline dark:text-teal-400"
                  >
                    Parent: {parentSnippet.title}
                  </button>
                )}
                {derivedChildren.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-slate-500 dark:text-slate-400">
                      Derived ({derivedChildren.length}):
                    </span>
                    {derivedChildren.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => setSelectedId(child.id)}
                        className="max-w-[200px] truncate rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:border-teal-600/40 hover:text-teal-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-teal-300"
                        title={child.title}
                      >
                        {child.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
              {viewMode === 'edit' ? (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0D1424]">
                  <textarea
                    value={activeSnippet.code}
                    onChange={(e) => handleUpdate({ code: e.target.value })}
                    spellCheck={false}
                    aria-label="Code editor"
                    wrap="off"
                    rows={16}
                    className="block min-h-[260px] sm:min-h-[340px] w-full resize-y overflow-x-auto bg-transparent p-3 sm:p-4 font-mono text-[13px] leading-6 text-slate-900 outline-none dark:text-slate-100"
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

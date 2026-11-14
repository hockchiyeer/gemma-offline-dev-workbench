import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Columns2,
  Download,
  Eye,
  Pencil,
  Pin,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { DocCategory, DocPage, Project, SupportedLanguage } from '../types/vault';
import { useConfirm } from './ConfirmDialog';
import { MarkdownRenderer, slugifyHeading } from './MarkdownRenderer';

interface DocsViewProps {
  docs: DocPage[];
  projects: Project[];
  activeProjectId: string;
  onSaveDoc: (doc: DocPage) => void | Promise<void>;
  onDeleteDoc: (id: string) => Promise<void>;
  onSaveSnippetFromCode: (code: string, language: SupportedLanguage) => Promise<void>;
  onSendDocToGemma: (doc: DocPage, prompt: string) => void;
}

const CATEGORIES: Array<{ id: 'all' | DocCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'api', label: 'API' },
  { id: 'runbook', label: 'Runbook' },
  { id: 'notes', label: 'Notes' },
];

export const DocsView: React.FC<DocsViewProps> = ({
  docs,
  projects,
  activeProjectId,
  onSaveDoc,
  onDeleteDoc,
  onSaveSnippetFromCode,
  onSendDocToGemma,
}) => {
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | DocCategory>('all');
  const [selectedId, setSelectedId] = useState<string | null>(docs[0]?.id || null);
  const [mode, setMode] = useState<'preview' | 'edit' | 'split'>('split');
  const [mobileViewing, setMobileViewing] = useState(false);

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((d) => {
      if (activeProjectId !== 'all' && d.projectId !== activeProjectId) return false;
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (!q) return true;
      return d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q);
    });
  }, [docs, activeProjectId, categoryFilter, search]);

  const activeDoc = useMemo(
    () =>
      filteredDocs.find((d) => d.id === selectedId) ||
      docs.find((d) => d.id === selectedId) ||
      filteredDocs[0] ||
      null,
    [filteredDocs, docs, selectedId]
  );

  const outline = useMemo(() => {
    if (!activeDoc) return [];
    const items: Array<{ level: number; text: string; id: string }> = [];
    for (const line of activeDoc.content.split('\n')) {
      const m = line.match(/^(#{1,3})\s+(.+)$/);
      if (m) {
        items.push({
          level: m[1].length,
          text: m[2].trim(),
          id: slugifyHeading(m[2].trim()),
        });
      }
    }
    return items;
  }, [activeDoc]);

  const wordStats = useMemo(() => {
    if (!activeDoc) return { words: 0, readMins: 1 };
    const words = activeDoc.content.trim() ? activeDoc.content.trim().split(/\s+/).length : 0;
    return { words, readMins: Math.max(1, Math.ceil(words / 200)) };
  }, [activeDoc]);

  const handleCreateDoc = async () => {
    const now = Date.now();
    const targetProject =
      activeProjectId !== 'all' ? activeProjectId : projects[0]?.id || 'proj-core';
    const created: DocPage = {
      id: `doc-${crypto.randomUUID()}`,
      projectId: targetProject,
      title: 'Untitled Project Spec',
      category: 'architecture',
      pinned: false,
      content: `# Untitled Project Spec\n\n## Overview\n\nDocument architecture decisions, API contracts, and operational runbooks offline.\n\n## Implementation Notes\n\n- Works fully offline in encrypted IndexedDB\n- Sync code examples directly to Snippets\n`,
      createdAt: now,
      updatedAt: now,
    };
    await onSaveDoc(created);
    setSelectedId(created.id);
    setMode('edit');
    setMobileViewing(true);
  };

  const handleUpdate = (patch: Partial<DocPage>) => {
    if (!activeDoc) return;
    void onSaveDoc({ ...activeDoc, ...patch, updatedAt: Date.now() });
  };

  const handleDeleteCurrent = async () => {
    if (!activeDoc) return;
    const accepted = await confirm({
      title: 'Delete Documentation Page',
      message: `Remove "${activeDoc.title}" permanently from your local database?`,
      confirmLabel: 'Delete Page',
      destructive: true,
    });
    if (!accepted) return;
    await onDeleteDoc(activeDoc.id);
    setSelectedId(null);
    setMobileViewing(false);
  };

  const handleExportMarkdown = () => {
    if (!activeDoc) return;
    const safeName =
      activeDoc.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'document';
    const blob = new Blob([activeDoc.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Left Doc Index */}
      <aside
        className={`flex w-full flex-col border-b border-slate-200 bg-white lg:w-76 lg:shrink-0 lg:border-r lg:border-b-0 xl:w-84 dark:border-slate-800 dark:bg-slate-900/70 ${
          mobileViewing ? 'hidden lg:flex' : 'flex flex-1 lg:flex-initial'
        }`}
      >
        <div className="space-y-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Project Documentation
            </h2>
            <button
              type="button"
              onClick={handleCreateDoc}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-500 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              New Doc
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search documentation..."
              className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 pr-3 pl-9 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-950">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategoryFilter(cat.id)}
                className={`min-h-[40px] lg:min-h-[32px] rounded-md px-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  categoryFilter === cat.id
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-200/80 dark:divide-slate-800/80">
          {filteredDocs.length === 0 ? (
            <div className="p-6 text-center">
              <BookOpen className="mx-auto h-8 w-8 text-slate-400" />
              <p className="mt-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                No documentation pages
              </p>
              <button
                type="button"
                onClick={handleCreateDoc}
                className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <Plus className="h-3.5 w-3.5" />
                Write First Doc
              </button>
            </div>
          ) : (
            filteredDocs.map((doc) => {
              const isSelected = activeDoc?.id === doc.id;
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(doc.id);
                    setMobileViewing(true);
                  }}
                  className={`block w-full px-4 py-3.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-teal-50/70 dark:bg-teal-950/25'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {doc.title}
                    </span>
                    {doc.pinned && (
                      <Pin className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <span className="capitalize">{doc.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {new Date(doc.updatedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Markdown Studio */}
      <section
        className={`flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-[#0B1120] ${
          mobileViewing ? 'flex' : 'hidden lg:flex'
        }`}
      >
        {activeDoc ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMobileViewing(false)}
                  aria-label="Back to docs list"
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 text-slate-600 lg:hidden dark:border-slate-800 dark:text-slate-300"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <input
                  type="text"
                  value={activeDoc.title}
                  onChange={(e) => handleUpdate({ title: e.target.value })}
                  aria-label="Document title"
                  className="min-w-0 flex-1 bg-transparent text-base font-semibold text-slate-900 outline-none focus:underline dark:text-white"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
                  <button
                    type="button"
                    onClick={() => setMode('edit')}
                    className={`inline-flex min-h-[40px] lg:min-h-[34px] items-center gap-1 rounded-md px-2.5 text-xs font-medium ${
                      mode === 'edit'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Write
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('split')}
                    className={`hidden min-h-[40px] lg:min-h-[34px] items-center gap-1 rounded-md px-2.5 text-xs font-medium md:inline-flex ${
                      mode === 'split'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                    Split
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('preview')}
                    className={`inline-flex min-h-[40px] lg:min-h-[34px] items-center gap-1 rounded-md px-2.5 text-xs font-medium ${
                      mode === 'preview'
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Preview
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => handleUpdate({ pinned: !activeDoc.pinned })}
                  aria-label={activeDoc.pinned ? 'Unpin document' : 'Pin document'}
                  className={`flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800 ${
                    activeDoc.pinned
                      ? 'text-teal-600 dark:text-teal-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <Pin className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={handleExportMarkdown}
                  aria-label="Download Markdown file"
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Download className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={handleDeleteCurrent}
                  aria-label="Delete document"
                  className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-slate-200 bg-white text-red-600 hover:bg-red-50 dark:border-slate-800 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/60 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/30">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Document category"
                  value={activeDoc.category}
                  onChange={(e) => handleUpdate({ category: e.target.value as DocCategory })}
                  className="min-h-[40px] lg:min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                >
                  <option value="architecture">Architecture</option>
                  <option value="api">API</option>
                  <option value="runbook">Runbook</option>
                  <option value="notes">Notes</option>
                </select>

                <select
                  aria-label="Document project"
                  value={activeDoc.projectId}
                  onChange={(e) => handleUpdate({ projectId: e.target.value })}
                  className="min-h-[40px] lg:min-h-[36px] rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
                  {wordStats.words} words · {wordStats.readMins} min read
                </span>
              </div>

              <button
                type="button"
                onClick={() =>
                  onSendDocToGemma(
                    activeDoc,
                    'Review this project documentation for technical gaps, clarify unclear steps, and suggest concrete code examples.'
                  )
                }
                className="inline-flex min-h-[40px] lg:min-h-[34px] items-center gap-1.5 rounded-lg border border-teal-600/30 bg-teal-500/10 px-3 text-xs font-medium text-teal-700 hover:bg-teal-500/20 whitespace-nowrap shrink-0 dark:text-teal-300"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Review with Gemma
              </button>
            </div>

            <div className="flex min-h-0 flex-1 overflow-hidden">
              {(mode === 'edit' || mode === 'split') && (
                <div
                  className={`flex-1 overflow-y-auto p-4 ${
                    mode === 'split' ? 'border-r border-slate-200 dark:border-slate-800' : ''
                  }`}
                >
                  <textarea
                    value={activeDoc.content}
                    onChange={(e) => handleUpdate({ content: e.target.value })}
                    aria-label="Markdown editor"
                    className="h-full min-h-[420px] w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-[13px] leading-6 text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-[#0D1424] dark:text-slate-100"
                  />
                </div>
              )}

              {(mode === 'preview' || mode === 'split') && (
                <div className="flex flex-1 overflow-y-auto p-5 sm:p-6">
                  <div className="mx-auto w-full max-w-3xl">
                    <MarkdownRenderer
                      content={activeDoc.content}
                      onSaveSnippet={onSaveSnippetFromCode}
                    />
                  </div>
                </div>
              )}

              {outline.length > 0 && mode === 'preview' && (
                <aside className="hidden w-56 shrink-0 border-l border-slate-200 bg-white/50 p-4 xl:block dark:border-slate-800 dark:bg-slate-900/30">
                  <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Outline
                  </div>
                  <nav className="mt-3 space-y-1.5">
                    {outline.map((h, idx) => (
                      <a
                        key={`${h.id}-${idx}`}
                        href={`#${h.id}`}
                        className="block truncate text-xs text-slate-600 hover:text-teal-600 dark:text-slate-400 dark:hover:text-teal-400"
                        style={{ paddingLeft: `${(h.level - 1) * 10}px` }}
                      >
                        {h.text}
                      </a>
                    ))}
                  </nav>
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <BookOpen className="mx-auto h-10 w-10 text-slate-400" />
              <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-300">
                Select or create a documentation page
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

import React, { useEffect, useId, useRef, useState } from 'react';
import { Eye, FolderGit2, FolderOpen, Loader2, X } from 'lucide-react';
import {
  canUseDirectDirectoryPicker,
  isBrowserSnapshotPath,
  isBrowserWorkspacePath,
  parseBrowserWorkspaceName,
} from '../lib/browserWorkspace';
import { loadLastWorkspacePath, saveLastWorkspacePath } from '../lib/workspaceClient';
import type { GatheredContext } from '../lib/workspaceContext';
import type { ChatWorkspace } from '../types/vault';
import type { BrowseWorkspaceResult, WorkspaceInfo } from '../types/workspace';

export interface WorkspacePreview {
  query: string;
  gathered: GatheredContext;
}

interface WorkspaceBarProps {
  available: boolean;
  serverAvailable?: boolean;
  browserAvailable?: boolean;
  directPickerAvailable?: boolean;
  needsPermission?: boolean;
  workspace?: ChatWorkspace;
  info: WorkspaceInfo | null;
  connecting: boolean;
  error: string | null;
  openError: string | null;
  opening: boolean;
  knownPaths: string[];
  inputBudget: number;
  preview: WorkspacePreview | null;
  previewing: boolean;
  excluded: Set<string>;
  busy: boolean;
  onOpen: (path: string) => void;
  onBrowseServer?: (initialDir?: string, signal?: AbortSignal) => Promise<BrowseWorkspaceResult>;
  onCancelBrowseServer?: () => Promise<void> | void;
  onPickBrowser?: () => void;
  onPickBrowserFiles?: (files: FileList) => void;
  onReconnectBrowser?: () => void;
  onClose: () => void;
  onToggle: (key: 'repoMap' | 'autoRetrieve', value: boolean) => void;
  onPreview: () => void;
  onToggleExcluded: (key: string) => void;
}

export const WorkspaceBar: React.FC<WorkspaceBarProps> = ({
  available,
  serverAvailable = true,
  browserAvailable = false,
  directPickerAvailable = false,
  needsPermission = false,
  workspace,
  info,
  connecting,
  error,
  openError,
  opening,
  knownPaths,
  inputBudget,
  preview,
  previewing,
  excluded,
  busy,
  onOpen,
  onBrowseServer,
  onCancelBrowseServer,
  onPickBrowser,
  onPickBrowserFiles,
  onReconnectBrowser,
  onClose,
  onToggle,
  onPreview,
  onToggleExcluded,
}) => {
  const [formOpen, setFormOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState(() => loadLastWorkspacePath());
  const [browsing, setBrowsing] = useState(false);
  const [serverBrowseSupported, setServerBrowseSupported] = useState(true);
  const datalistId = useId();
  const dirInputRef = useRef<HTMLInputElement | null>(null);
  const browseBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const userEditedPathRef = useRef(false);
  const pathDraftRef = useRef(pathDraft);
  const suppressBlurOpenRef = useRef(false);
  const lastAttemptedPathRef = useRef<string | null>(null);
  const browseAbortRef = useRef<AbortController | null>(null);
  const browseCancelledRef = useRef(false);
  pathDraftRef.current = pathDraft;

  useEffect(() => {
    setServerBrowseSupported(true);
  }, [serverAvailable]);

  useEffect(() => {
    return () => {
      browseAbortRef.current?.abort();
      browseAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = dirInputRef.current;
    if (!el) return;
    el.webkitdirectory = true;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  });

  useEffect(() => {
    if (workspace) {
      setFormOpen(false);
      lastAttemptedPathRef.current = null;
      if (!isBrowserWorkspacePath(workspace.path)) {
        userEditedPathRef.current = false;
        pathDraftRef.current = workspace.path;
        setPathDraft(workspace.path);
        saveLastWorkspacePath(workspace.path);
      }
    }
  }, [workspace?.path]);

  useEffect(() => {
    if (!workspace && !userEditedPathRef.current && !pathDraft && knownPaths[0]) {
      pathDraftRef.current = knownPaths[0];
      setPathDraft(knownPaths[0]);
    }
  }, [workspace, knownPaths, pathDraft]);

  if (!available && !workspace) return null;

  const openPath = (rawPath: string, via: 'blur' | 'submit' | 'browse') => {
    const trimmed = rawPath.trim();
    if (!trimmed || opening || browsing) return;
    if (via === 'blur' && lastAttemptedPathRef.current === trimmed) return;
    lastAttemptedPathRef.current = trimmed;
    saveLastWorkspacePath(trimmed);
    onOpen(trimmed);
  };

  const triggerBrowserFolderPick = () => {
    if (directPickerAvailable && canUseDirectDirectoryPicker() && onPickBrowser) {
      onPickBrowser();
      return;
    }
    const el = dirInputRef.current;
    if (el) {
      el.value = '';
      el.click();
    }
  };

  const handleBrowseClick = async () => {
    if (browsing || opening) return;
    if (serverAvailable && onBrowseServer && serverBrowseSupported) {
      const controller = new AbortController();
      browseAbortRef.current = controller;
      browseCancelledRef.current = false;
      setBrowsing(true);
      try {
        const initial = pathDraftRef.current.trim() || knownPaths[0] || undefined;
        const res = await onBrowseServer(initial, controller.signal);
        if (browseCancelledRef.current || controller.signal.aborted) {
          return;
        }
        if (res.supported) {
          if (!res.cancelled && res.path) {
            userEditedPathRef.current = false;
            pathDraftRef.current = res.path;
            setPathDraft(res.path);
            lastAttemptedPathRef.current = res.path;
            saveLastWorkspacePath(res.path);
            onOpen(res.path);
          }
          return;
        }
        setServerBrowseSupported(false);
      } finally {
        if (browseAbortRef.current === controller) {
          browseAbortRef.current = null;
        }
        setBrowsing(false);
      }
      if (!browseCancelledRef.current && browserAvailable) {
        triggerBrowserFolderPick();
      }
      return;
    }
    triggerBrowserFolderPick();
  };

  const hiddenDirInput = onPickBrowserFiles ? (
    <input
      ref={dirInputRef}
      type="file"
      multiple
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      onChange={(e) => {
        if (e.target.files && e.target.files.length > 0) {
          onPickBrowserFiles(e.target.files);
        }
        e.target.value = '';
      }}
    />
  ) : null;

  const previewTotal = preview
    ? preview.gathered.use.items
        .filter((i) => !(i.via === 'retrieved' && excluded.has(i.label)))
        .reduce((n, i) => n + i.tokens, 0)
    : 0;

  if (!workspace) {
    const browserOnly = !serverAvailable && browserAvailable;
    return (
      <div className="space-y-2">
        {hiddenDirInput}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {!formOpen || browserOnly ? (
            <button
              type="button"
              disabled={busy || opening}
              onClick={() => {
                if (browserOnly) {
                  triggerBrowserFolderPick();
                } else {
                  lastAttemptedPathRef.current = null;
                  setFormOpen(true);
                }
              }}
              className="inline-flex min-h-[30px] items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-teal-500/40 hover:bg-teal-50/50 hover:text-teal-800 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 dark:hover:text-teal-300"
              title="Connect a local project folder on this computer for @-mentions, search, and project outlines"
            >
              {opening ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-600 dark:text-teal-400" aria-hidden="true" />
              ) : (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden="true" />
              )}
              Open project folder
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                openPath(pathDraftRef.current, 'submit');
              }}
              className="flex w-full flex-wrap items-center gap-2"
            >
              <div className="relative min-w-[200px] flex-1">
                <input
                  type="text"
                  list={datalistId}
                  value={pathDraft}
                  onChange={(e) => {
                    const next = e.target.value;
                    userEditedPathRef.current = true;
                    lastAttemptedPathRef.current = null;
                    pathDraftRef.current = next;
                    setPathDraft(next);
                    saveLastWorkspacePath(next);
                  }}
                  onBlur={(e) => {
                    const suppressed = suppressBlurOpenRef.current;
                    suppressBlurOpenRef.current = false;
                    const nextFocus = e.relatedTarget as Node | null;
                    if (
                      suppressed ||
                      (nextFocus &&
                        (nextFocus === cancelBtnRef.current || nextFocus === browseBtnRef.current))
                    ) {
                      return;
                    }
                    openPath(pathDraftRef.current, 'blur');
                  }}
                  placeholder="/path/to/project or C:\code\project"
                  aria-label="Project folder path"
                  autoFocus
                  className="min-h-[36px] w-full rounded-lg border border-slate-300 bg-slate-50 px-3 pr-8 font-mono text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                {opening && (
                  <Loader2
                    className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-teal-600 dark:text-teal-400"
                    aria-label="Opening project folder"
                  />
                )}
              </div>
              <datalist id={datalistId}>
                {knownPaths.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              {((serverAvailable && Boolean(onBrowseServer) && serverBrowseSupported) || browserAvailable) && (
                <button
                  ref={browseBtnRef}
                  type="button"
                  disabled={opening || browsing}
                  onMouseDown={() => {
                    suppressBlurOpenRef.current = true;
                  }}
                  onClick={() => {
                    suppressBlurOpenRef.current = false;
                    void handleBrowseClick();
                  }}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  title={
                    browsing
                      ? 'Waiting for folder selection dialog…'
                      : serverAvailable && serverBrowseSupported
                        ? 'Browse for a project folder on this computer'
                        : 'Pick a folder using your browser folder dialog'
                  }
                >
                  {browsing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {browsing ? 'Choosing folder…' : 'Browse…'}
                </button>
              )}
              <button
                ref={cancelBtnRef}
                type="button"
                onMouseDown={() => {
                  suppressBlurOpenRef.current = true;
                }}
                onClick={() => {
                  suppressBlurOpenRef.current = false;
                  if (browsing) {
                    browseCancelledRef.current = true;
                    browseAbortRef.current?.abort();
                    browseAbortRef.current = null;
                    setBrowsing(false);
                    void onCancelBrowseServer?.();
                    return;
                  }
                  setFormOpen(false);
                }}
                title={browsing ? 'Close the folder dialog and reset Browse…' : 'Cancel'}
                className="min-h-[36px] rounded-lg border border-slate-300 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </form>
          )}
        </div>
        {openError && (
          <p role="alert" className="text-[11px] font-medium text-rose-600 dark:text-rose-400">
            {openError}
          </p>
        )}
      </div>
    );
  }

  const isBrowser = isBrowserWorkspacePath(workspace.path);
  const isSnapshot = isBrowserSnapshotPath(workspace.path);
  const displayName = info?.name || workspace.name || parseBrowserWorkspaceName(workspace.path);

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/90 px-3 py-2 text-[11px] dark:border-slate-800 dark:bg-slate-950/70">
      {hiddenDirInput}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className="inline-flex min-w-0 items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200"
          title={isBrowser ? `${displayName} (browser folder access)` : workspace.path}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          <span className="truncate font-mono">{displayName}</span>
        </span>

        {connecting ? (
          <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Indexing…
          </span>
        ) : info ? (
          <span className="tabular-nums text-slate-500 dark:text-slate-400">
            {info.fileCount} files{info.truncated ? ' (capped)' : ''}
            {info.isGit ? ' · Git' : ''}
            {info.source === 'browser' ? ' · Browser folder' : info.watching ? ' · Live' : ''}
            {info.embeddings.state === 'running'
              ? ` · embeddings ${info.embeddings.embedded}/${info.embeddings.total}`
              : info.embeddings.state === 'idle' && info.embeddings.model
                ? ` · ${info.embeddings.model}`
                : ''}
          </span>
        ) : null}

        <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={workspace.autoRetrieve}
            disabled={busy}
            onChange={(e) => onToggle('autoRetrieve', e.target.checked)}
            className="h-3.5 w-3.5 accent-teal-600"
          />
          Auto-search
        </label>

        <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={workspace.repoMap}
            disabled={busy}
            onChange={(e) => onToggle('repoMap', e.target.checked)}
            className="h-3.5 w-3.5 accent-teal-600"
          />
          Outline
        </label>

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy || previewing || !info}
            onClick={onPreview}
            className="inline-flex min-h-[26px] items-center gap-1 rounded-md border border-slate-200 bg-white px-2 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            title="Inspect which project files and excerpts will be sent with this message"
          >
            {previewing ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Eye className="h-3 w-3" aria-hidden="true" />
            )}
            Preview
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="Close project folder"
            title="Disconnect project folder from this chat"
            className="inline-flex min-h-[26px] min-w-[26px] items-center justify-center rounded-md text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>

      {(error || openError || info?.embeddings.state === 'error') && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[11px] text-rose-600 dark:text-rose-400">
          <span>{error || openError || info?.embeddings.error}</span>
          {needsPermission && (
            <button
              type="button"
              onClick={() => {
                if (!isSnapshot && directPickerAvailable && onReconnectBrowser) onReconnectBrowser();
                else triggerBrowserFolderPick();
              }}
              className="rounded-md bg-teal-600 px-2 py-0.5 font-medium text-white hover:bg-teal-500"
            >
              {isSnapshot || !directPickerAvailable ? 'Choose folder' : 'Grant access'}
            </button>
          )}
        </div>
      )}

      {preview && (
        <div className="space-y-1.5 border-t border-slate-200/80 pt-2 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-medium text-slate-700 dark:text-slate-300">
            <span>
              Project context preview · ~{previewTotal} tokens
              {previewTotal > Math.floor(inputBudget * 0.5)
                ? ' (trimming may apply to fit context share)'
                : ''}
            </span>
            {preview.gathered.use.mode && (
              <span className="font-mono text-[10px] uppercase text-slate-400">
                {preview.gathered.use.mode} search
              </span>
            )}
          </div>
          {preview.gathered.use.items.length === 0 ? (
            <p className="text-slate-500 dark:text-slate-400">
              No project items matched yet. Type a question or @mention a file.
            </p>
          ) : (
            <ul className="space-y-1 font-mono text-[11px]">
              {preview.gathered.use.items.map((item, idx) => {
                const isRetrieved = item.via === 'retrieved';
                const checked = !(isRetrieved && excluded.has(item.label));
                return (
                  <li key={`${item.via}-${item.label}-${idx}`} className="flex items-center gap-2">
                    {isRetrieved ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleExcluded(item.label)}
                        aria-label={`Include retrieved ${item.label}`}
                        className="h-3.5 w-3.5 shrink-0 accent-teal-600"
                      />
                    ) : (
                      <span className="w-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className="w-16 shrink-0 font-sans text-[10px] uppercase tracking-wide text-slate-400">
                      {item.via === 'retrieved' ? 'found' : item.via}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        checked ? 'text-slate-700 dark:text-slate-200' : 'line-through text-slate-400'
                      }`}
                    >
                      {item.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-400">~{item.tokens}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {preview.gathered.warnings.length > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              {preview.gathered.warnings.join(' ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

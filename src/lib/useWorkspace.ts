import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserWorkspaceConnection,
  canUseDirectDirectoryPicker,
  isBrowserSnapshotPath,
  isBrowserWorkspacePath,
  requestBrowserWorkspaceAccess,
  supportsBrowserFolderAccess,
} from './browserWorkspace';
import { isLoopbackBaseUrl } from './gemmaClient';
import {
  probeWorkspaceAvailable,
  WorkspaceConnection,
  type WorkspaceConnectionLike,
} from './workspaceClient';
import type { ChatWorkspace, LocalRuntimeConfig } from '../types/vault';
import type { EmbeddingSetting, WorkspaceInfo } from '../types/workspace';

export function embeddingSettingFor(config: LocalRuntimeConfig): EmbeddingSetting | null {
  const model = config.embeddingModel?.trim();
  if (config.kind !== 'ollama' || !model) return null;
  if (!isLoopbackBaseUrl(config.baseUrl)) return null;
  return { baseUrl: config.baseUrl, model };
}

export interface WorkspaceHookState {
  available: boolean;
  serverAvailable: boolean;
  browserAvailable: boolean;
  directPickerAvailable: boolean;
  conn: WorkspaceConnectionLike | null;
  info: WorkspaceInfo | null;
  connecting: boolean;
  error: string | null;
  needsPermission: boolean;
  reconnectBrowser: () => Promise<void>;
}

export function useWorkspace(
  workspace: ChatWorkspace | undefined,
  embedding: EmbeddingSetting | null
): WorkspaceHookState {
  const [serverAvailable, setServerAvailable] = useState(false);
  const [browserAvailable, setBrowserAvailable] = useState(() => supportsBrowserFolderAccess());
  const [directPickerAvailable, setDirectPickerAvailable] = useState(() => canUseDirectDirectoryPicker());
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    setBrowserAvailable(supportsBrowserFolderAccess());
    setDirectPickerAvailable(canUseDirectDirectoryPicker());
    const ac = new AbortController();
    probeWorkspaceAvailable(ac.signal)
      .then((ok) => {
        if (!ac.signal.aborted) setServerAvailable(ok);
      })
      .catch(() => {
        if (!ac.signal.aborted) setServerAvailable(false);
      });
    return () => ac.abort();
  }, []);

  const embBase = embedding?.baseUrl ?? '';
  const embModel = embedding?.model ?? '';
  const isBrowser = Boolean(workspace?.path && isBrowserWorkspacePath(workspace.path));

  const conn = useMemo<WorkspaceConnectionLike | null>(() => {
    if (!workspace?.path) return null;
    const emb = embBase && embModel ? { baseUrl: embBase, model: embModel } : null;
    if (isBrowserWorkspacePath(workspace.path)) {
      return new BrowserWorkspaceConnection(workspace.path, emb);
    }
    if (!serverAvailable) return null;
    return new WorkspaceConnection(workspace.path, emb);
  }, [serverAvailable, workspace?.path, embBase, embModel]);

  useEffect(() => {
    if (!conn) {
      setInfo(null);
      setConnecting(false);
      setError(
        workspace?.path && !isBrowser && !serverAvailable
          ? 'This project path requires the local Node server.'
          : null
      );
      setNeedsPermission(false);
      return;
    }

    let stopped = false;
    const ac = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    setConnecting(true);
    setError(null);
    setNeedsPermission(false);

    const schedulePoll = (latest: WorkspaceInfo) => {
      if (stopped || latest.embeddings.state !== 'running') return;
      pollTimer = setTimeout(async () => {
        if (stopped) return;
        try {
          const next = await conn.info(ac.signal);
          if (stopped) return;
          setInfo(next);
          schedulePoll(next);
        } catch {
          // Stop polling quietly on transient error or unmount.
        }
      }, 1200);
    };

    conn
      .open(ac.signal)
      .then((opened) => {
        if (stopped) return;
        setInfo(opened);
        setConnecting(false);
        setNeedsPermission(false);
        schedulePoll(opened);
      })
      .catch((err) => {
        if (stopped) return;
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return;
        setInfo(null);
        setConnecting(false);
        const msg = err instanceof Error ? err.message : 'Unable to open project folder.';
        setError(msg);
        setNeedsPermission(
          isBrowser &&
            (!isBrowserSnapshotPath(workspace?.path || '')
              ? /permission|select this project folder/i.test(msg)
              : /select this project folder/i.test(msg))
        );
      });

    return () => {
      stopped = true;
      ac.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [conn, retryToken, isBrowser, serverAvailable, workspace?.path]);

  const reconnectBrowser = useCallback(async () => {
    if (!workspace?.path || !isBrowserWorkspacePath(workspace.path)) return;
    setError(null);
    try {
      await requestBrowserWorkspaceAccess(workspace.path);
      setNeedsPermission(false);
      setRetryToken((n) => n + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not regain folder permission.';
      setError(msg);
      setNeedsPermission(/permission|select this project folder/i.test(msg));
    }
  }, [workspace?.path]);

  return {
    available: serverAvailable || browserAvailable,
    serverAvailable,
    browserAvailable,
    directPickerAvailable,
    conn,
    info,
    connecting,
    error,
    needsPermission,
    reconnectBrowser,
  };
}

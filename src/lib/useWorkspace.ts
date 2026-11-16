import { useEffect, useMemo, useState } from 'react';
import { isLoopbackBaseUrl } from './gemmaClient';
import { probeWorkspaceAvailable, WorkspaceConnection } from './workspaceClient';
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
  conn: WorkspaceConnection | null;
  info: WorkspaceInfo | null;
  connecting: boolean;
  error: string | null;
}

export function useWorkspace(
  workspace: ChatWorkspace | undefined,
  embedding: EmbeddingSetting | null
): WorkspaceHookState {
  const [available, setAvailable] = useState(false);
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    probeWorkspaceAvailable(ac.signal)
      .then((ok) => {
        if (!ac.signal.aborted) setAvailable(ok);
      })
      .catch(() => {
        if (!ac.signal.aborted) setAvailable(false);
      });
    return () => ac.abort();
  }, []);

  const embBase = embedding?.baseUrl ?? '';
  const embModel = embedding?.model ?? '';
  const conn = useMemo(() => {
    if (!available || !workspace?.path) return null;
    return new WorkspaceConnection(
      workspace.path,
      embBase && embModel ? { baseUrl: embBase, model: embModel } : null
    );
  }, [available, workspace?.path, embBase, embModel]);

  useEffect(() => {
    if (!conn) {
      setInfo(null);
      setConnecting(false);
      setError(null);
      return;
    }

    let stopped = false;
    const ac = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    setConnecting(true);
    setError(null);

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
        schedulePoll(opened);
      })
      .catch((err) => {
        if (stopped) return;
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return;
        setInfo(null);
        setConnecting(false);
        setError(err instanceof Error ? err.message : 'Unable to open project folder.');
      });

    return () => {
      stopped = true;
      ac.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [conn]);

  return { available, conn, info, connecting, error };
}

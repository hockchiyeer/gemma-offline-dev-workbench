import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalRuntimeConfig } from '../types/vault';
import type { ProbeResult } from '../lib/gemmaClient';
import { fetchSetupStatus, RUNTIME_CHANGED_EVENT, type SetupStatus } from '../lib/gemmaSetup';
import { deriveRuntimeStatus, nextPollDelayMs, type RuntimeStatus } from '../lib/runtimeStatus';

interface Options {
  config: LocalRuntimeConfig | undefined;
  probe: ProbeResult;
  /** Re-probe the runtime without showing spinners elsewhere. */
  refreshProbe: () => Promise<void>;
}

/**
 * Keeps the local-LLM status fresh: re-checks on a timer (fast while starting/installing, slow when healthy),
 * when the tab becomes visible or the network returns, and immediately when auto-setup starts or is cancelled.
 */
export function useRuntimeStatus({ config, probe, refreshProbe }: Options) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshProbeRef = useRef(refreshProbe);
  refreshProbeRef.current = refreshProbe;
  const reqIdRef = useRef(0);
  const enabled = Boolean(config);

  const status: RuntimeStatus = useMemo(
    () =>
      deriveRuntimeStatus({
        checked,
        probe,
        setup,
        config: config ?? { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', selectedModel: '' },
      }),
    [checked, probe, setup, config]
  );

  const statusRef = useRef(status);
  statusRef.current = status;

  const check = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setRefreshing(true);
    try {
      const [, setupStatus] = await Promise.all([refreshProbeRef.current(), fetchSetupStatus()]);
      if (reqId !== reqIdRef.current) return;
      setSetup(setupStatus);
      setChecked(true);
      setLastCheckedAt(Date.now());
    } finally {
      if (reqId === reqIdRef.current) {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (cancelled) return;
      if (!document.hidden) await check();
      if (cancelled) return;
      timer = setTimeout(loop, nextPollDelayMs(statusRef.current));
    };
    const kick = () => {
      if (timer) clearTimeout(timer);
      void loop();
    };
    const onVisible = () => {
      if (!document.hidden) kick();
    };

    void loop();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', kick);
    window.addEventListener(RUNTIME_CHANGED_EVENT, kick);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', kick);
      window.removeEventListener(RUNTIME_CHANGED_EVENT, kick);
    };
  }, [enabled, check]);

  return { status, refreshing, lastCheckedAt, recheck: check };
}

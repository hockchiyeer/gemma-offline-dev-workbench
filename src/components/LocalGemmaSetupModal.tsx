import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, Terminal, X } from 'lucide-react';
import {
  isLoopbackBaseUrl,
  RECOMMENDED_GEMMA_MODELS,
  type ProbeResult,
  type WebGPUStatus,
} from '../lib/gemmaClient';
import {
  cancelGemmaSetup,
  fetchSetupStatus,
  startGemmaSetup,
  type SetupStatus,
} from '../lib/gemmaSetup';
import type { GemmaModelInfo, LocalRuntimeConfig, RuntimeKind } from '../types/vault';

interface LocalGemmaSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: LocalRuntimeConfig;
  probe: ProbeResult;
  webgpu: WebGPUStatus;
  probing: boolean;
  onSaveConfig: (next: LocalRuntimeConfig) => void | Promise<void>;
  onRescan: (overrideConfig?: LocalRuntimeConfig) => Promise<void>;
}

export const LocalGemmaSetupModal: React.FC<LocalGemmaSetupModalProps> = ({
  isOpen,
  onClose,
  config,
  probe,
  webgpu,
  probing,
  onSaveConfig,
  onRescan,
}) => {
  const [draft, setDraft] = useState<LocalRuntimeConfig>(config);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const onRescanRef = useRef(onRescan);
  onRescanRef.current = onRescan;

  // Poll the local server for auto-setup status while the dialog is open (fast while a job runs).
  useEffect(() => {
    if (!isOpen) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const status = await fetchSetupStatus();
      if (stop) return;
      setSetup(status);
      if (wasRunning.current && status && !status.job.running && status.job.phase === 'done') {
        void onRescanRef.current();
      }
      wasRunning.current = Boolean(status?.job.running);
      timer = setTimeout(tick, status?.job.running ? 1000 : 5000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [isOpen]);

  const handleAutoSetup = async () => {
    setSetupError(null);
    try {
      await startGemmaSetup(setup?.system.recommendedModel);
      setSetup(await fetchSetupStatus());
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Auto-setup failed to start.');
    }
  };

  useEffect(() => {
    setDraft(config);
    setValidationError(null);
  }, [config, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleKindChange = (kind: RuntimeKind) => {
    const defaultUrl =
      kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234';
    setDraft({ ...draft, kind, baseUrl: defaultUrl });
    setValidationError(null);
  };

  const handleCopy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1600);
    } catch {
      // ignore
    }
  };

  const handleApplyAndTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoopbackBaseUrl(draft.baseUrl)) {
      setValidationError(
        'Endpoint must use http://localhost or http://127.0.0.1 so code never leaves your device.'
      );
      return;
    }
    setValidationError(null);
    await onSaveConfig(draft);
    await onRescan(draft);
  };

  const availableModels: GemmaModelInfo[] = probe.models;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="runtime-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-slate-200 bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:rounded-2xl sm:p-6 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
          <div>
            <h2
              id="runtime-modal-title"
              className="text-lg font-semibold text-slate-900 dark:text-white"
            >
              Local Google Gemma Runtime
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Loopback-only execution · Zero cloud keys · Zero paid API calls
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close runtime settings"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleApplyAndTest} className="mt-5 space-y-5">
          <div>
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Local Inference Engine
            </span>
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-950">
              <button
                type="button"
                onClick={() => handleKindChange('ollama')}
                className={`min-h-[40px] rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  draft.kind === 'ollama'
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                Ollama (11434)
              </button>
              <button
                type="button"
                onClick={() => handleKindChange('openai')}
                className={`min-h-[40px] rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  draft.kind === 'openai'
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                llama.cpp / LM Studio (1234)
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="runtime-endpoint"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Localhost Endpoint URL
              </label>
              <input
                id="runtime-endpoint"
                type="url"
                value={draft.baseUrl}
                onChange={(e) => {
                  setDraft({ ...draft, baseUrl: e.target.value });
                  setValidationError(null);
                }}
                placeholder="http://127.0.0.1:11434"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 font-mono text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="runtime-model"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Active Gemma Model Tag
              </label>
              {availableModels.length > 0 ? (
                <select
                  id="runtime-model"
                  value={draft.selectedModel}
                  onChange={(e) => setDraft({ ...draft, selectedModel: e.target.value })}
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3 font-mono text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                >
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.parameterLabel ? `(${m.parameterLabel})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="runtime-model"
                  type="text"
                  value={draft.selectedModel}
                  onChange={(e) => setDraft({ ...draft, selectedModel: e.target.value })}
                  placeholder="gemma4:e4b"
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 font-mono text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              )}
            </div>
          </div>

          {validationError && (
            <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {validationError}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="runtime-temp" className="font-medium text-slate-700 dark:text-slate-300">
                  Temperature
                </label>
                <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {draft.temperature.toFixed(2)}
                </span>
              </div>
              <input
                id="runtime-temp"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.temperature}
                onChange={(e) => setDraft({ ...draft, temperature: parseFloat(e.target.value) })}
                className="mt-3 w-full accent-teal-600"
              />
            </div>

            <div>
              <label
                htmlFor="runtime-max-tokens"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Max Output Tokens
              </label>
              <input
                id="runtime-max-tokens"
                type="number"
                min={256}
                max={32768}
                step={256}
                value={draft.maxTokens}
                onChange={(e) =>
                  setDraft({ ...draft, maxTokens: Math.max(256, Number(e.target.value) || 2048) })
                }
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 font-mono text-xs tabular-nums text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            <div>
              <label
                htmlFor="runtime-context-tokens"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Context Window (num_ctx)
              </label>
              <input
                id="runtime-context-tokens"
                type="number"
                min={2048}
                max={262144}
                step={1024}
                value={draft.contextTokens ?? 8192}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    contextTokens: Math.max(2048, Number(e.target.value) || 8192),
                  })
                }
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 font-mono text-xs tabular-nums text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="runtime-reasoning"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Reasoning (Ollama)
            </label>
            <select
              id="runtime-reasoning"
              value={draft.reasoning ?? 'auto'}
              onChange={(e) =>
                setDraft({ ...draft, reasoning: e.target.value === 'off' ? 'off' : 'auto' })
              }
              className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              <option value="auto">Auto — model thinks first (best quality, slower)</option>
              <option value="off">Off — answer directly (fastest, recommended on CPU-only PCs)</option>
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="runtime-keep-alive"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                Keep model loaded (minutes, Ollama)
              </label>
              <input
                id="runtime-keep-alive"
                type="number"
                min={0}
                max={1440}
                step={5}
                value={draft.keepAliveMinutes ?? 30}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    keepAliveMinutes: Math.min(1440, Math.max(0, Math.round(Number(e.target.value) || 0))),
                  })
                }
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 font-mono text-xs tabular-nums text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                A loaded model answers follow-ups much faster. 0 unloads right after each reply.
              </p>
            </div>

            <label
              htmlFor="runtime-auto-compact"
              className="flex min-h-[44px] cursor-pointer items-start gap-2.5 self-start rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
            >
              <input
                id="runtime-auto-compact"
                type="checkbox"
                checked={draft.autoCompact !== false}
                onChange={(e) => setDraft({ ...draft, autoCompact: e.target.checked })}
                className="mt-0.5 h-4 w-4 shrink-0 accent-teal-600"
              />
              <span>
                <span className="font-medium">Condense long chats</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                  Summarise the oldest turns with the local model instead of dropping them when a chat outgrows the
                  context window.
                </span>
              </span>
            </label>
          </div>

          <div>
            <label
              htmlFor="runtime-system-prompt"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Coding System Instruction
            </label>
            <textarea
              id="runtime-system-prompt"
              rows={3}
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              className="mt-1.5 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs leading-relaxed text-slate-900 outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          {setup && (
            <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-4 text-xs dark:border-teal-900/60 dark:bg-teal-950/20">
              <div className="font-medium text-slate-900 dark:text-white">Automatic Gemma setup</div>
              <p className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
                {setup.system.ollamaRunning &&
                setup.system.installedModels.some((m) => m.toLowerCase().includes('gemma'))
                  ? 'Ollama and a Gemma model are installed. Everything runs offline.'
                  : `Connects once to Ollama's servers to install Ollama (if missing) and download ${setup.system.recommendedModel} — recommended for ${setup.system.totalMemGiB} GB RAM. Afterwards, no internet connection is needed.`}
              </p>
              {setup.job.phase !== 'idle' && (
                <div className="mt-2" aria-live="polite">
                  <div className="text-slate-700 dark:text-slate-300">{setup.job.message}</div>
                  {setup.job.percent !== null && setup.job.running && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className="h-full bg-teal-600 transition-all"
                        style={{ width: `${setup.job.percent}%` }}
                      />
                    </div>
                  )}
                  {setup.job.manualHint && (
                    <div className="mt-1 text-slate-600 dark:text-slate-400">
                      {setup.job.manualHint}
                    </div>
                  )}
                </div>
              )}
              {setupError && <div className="mt-2 text-rose-600 dark:text-rose-400">{setupError}</div>}
              <div className="mt-3">
                {setup.job.running ? (
                  <button
                    type="button"
                    onClick={() => void cancelGemmaSetup()}
                    className="min-h-[40px] rounded-lg border border-slate-300 px-3 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleAutoSetup()}
                    className="min-h-[40px] rounded-lg bg-teal-600 px-4 font-medium text-white hover:bg-teal-500"
                  >
                    {setup.job.phase === 'error' ? 'Retry auto-setup' : 'Auto-setup Gemma'}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-slate-800 dark:text-slate-200">
                Diagnostics: {probe.connected ? `Connected (${probe.transport})` : 'Not Connected'}
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                WebGPU: {webgpu.supported ? webgpu.adapterName : 'Unavailable'}
              </span>
            </div>
            {!probe.connected && (
              <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400">
                {probe.error}
              </p>
            )}

            <div className="mt-3 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                <Terminal className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                Install Free Google Gemma Models Locally
              </div>
              {RECOMMENDED_GEMMA_MODELS.map((item) => {
                const cmd = `ollama pull ${item.tag}`;
                return (
                  <div
                    key={item.tag}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100">
                        {cmd}
                      </div>
                      <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                        {item.note}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(cmd)}
                      className="inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {copiedCmd === cmd ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={probing}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-teal-600 px-5 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${probing ? 'animate-spin' : ''}`} />
              {probing ? 'Scanning Localhost...' : 'Save & Scan Local Gemma'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

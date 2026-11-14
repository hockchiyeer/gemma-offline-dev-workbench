import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Code2,
  Cpu,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  thinkingHeadroom,
  buildGemmaMessages,
  streamLocalGemmaChat,
  type ProbeResult,
} from '../lib/gemmaClient';
import type {
  ChatAttachmentRef,
  ChatMessage,
  ChatSession,
  CodeSnippet,
  DocPage,
  LocalRuntimeConfig,
  SupportedLanguage,
} from '../types/vault';
import { useConfirm } from './ConfirmDialog';
import { MarkdownRenderer } from './MarkdownRenderer';

interface GemmaAssistantPaneProps {
  sessions: ChatSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onUpdateSession: (session: ChatSession, options?: { immediate?: boolean }) => void | Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
  snippets: CodeSnippet[];
  docs: DocPage[];
  runtimeConfig: LocalRuntimeConfig;
  probe: ProbeResult;
  probing: boolean;
  onRescanRuntime: () => Promise<void>;
  onOpenRuntimeModal: () => void;
  onSaveSnippetFromCode: (code: string, language: SupportedLanguage) => Promise<void>;
  queuedPrompt?: { prompt: string; attachments: ChatAttachmentRef[] } | null;
  onClearQueuedPrompt: () => void;
}

const CODING_STARTERS = [
  {
    label: 'Design REST / RPC API',
    prompt:
      'Design a clean, type-safe API module with input validation and structured error handling in TypeScript.',
  },
  {
    label: 'Optimize SQL Query',
    prompt:
      'Show how to write an indexed, injection-safe SQL query and explain its execution plan.',
  },
  {
    label: 'Python Async Worker',
    prompt:
      'Write an asyncio worker queue in Python with graceful shutdown and bounded concurrency.',
  },
  {
    label: 'Rust Error Handling',
    prompt:
      'Demonstrate idiomatic Rust error handling with custom Error enums and zero panics.',
  },
];

export const GemmaAssistantPane: React.FC<GemmaAssistantPaneProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onUpdateSession,
  onDeleteSession,
  snippets,
  docs,
  runtimeConfig,
  probe,
  probing,
  onRescanRuntime,
  onOpenRuntimeModal,
  onSaveSnippetFromCode,
  queuedPrompt,
  onClearQueuedPrompt,
}) => {
  const confirm = useConfirm();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachmentRef[]>([]);
  const [showAttachDrawer, setShowAttachDrawer] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingDraft, setStreamingDraft] = useState<{ msgId: string; text: string } | null>(
    null
  );
  const [thinkingText, setThinkingText] = useState('');
  const [modelLoaded, setModelLoaded] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [contextTrimmed, setContextTrimmed] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestDraftRef = useRef<string>('');
  const latestThinkingRef = useRef<string>('');
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || sessions[0] || null,
    [sessions, activeSessionId]
  );

  // Stop any in-flight local stream if the pane unmounts (e.g. vault auto-lock) so a late
  // completion can never write decrypted chat content after the key has been cleared.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Elapsed-time ticker so a slow cold start is visible instead of looking frozen.
  useEffect(() => {
    if (!streaming) {
      setWaitSeconds(0);
      return;
    }
    const id = setInterval(() => setWaitSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages.length, streaming]);

  useEffect(() => {
    if (queuedPrompt) {
      setInput(queuedPrompt.prompt);
      setAttachments(queuedPrompt.attachments);
      onClearQueuedPrompt();
    }
  }, [queuedPrompt, onClearQueuedPrompt]);

  const toggleAttachment = (ref: ChatAttachmentRef) => {
    setAttachments((prev) => {
      const exists = prev.some((a) => a.kind === ref.kind && a.id === ref.id);
      if (exists) return prev.filter((a) => !(a.kind === ref.kind && a.id === ref.id));
      return [...prev, ref];
    });
  };

  const resolveContextBlocks = (refs: ChatAttachmentRef[]) => {
    const blocks: Array<{ title: string; kind: string; content: string }> = [];
    for (const ref of refs) {
      if (ref.kind === 'snippet') {
        const s = snippets.find((item) => item.id === ref.id);
        if (s) {
          blocks.push({
            title: `${s.title} (${s.language})`,
            kind: 'snippet',
            content: `\`\`\`${s.language}\n${s.code}\n\`\`\``,
          });
        }
      } else {
        const d = docs.find((item) => item.id === ref.id);
        if (d) {
          blocks.push({
            title: d.title,
            kind: 'documentation',
            content: d.content,
          });
        }
      }
    }
    return blocks;
  };

  const handleDeleteCurrentSession = async () => {
    if (!activeSession || sessions.length <= 1) return;
    const accepted = await confirm({
      title: 'Delete Coding Session',
      message: `Delete "${activeSession.title}" and its local message history?`,
      confirmLabel: 'Delete Chat',
      destructive: true,
    });
    if (!accepted) return;
    await onDeleteSession(activeSession.id);
  };

  const handleSend = async (customPrompt?: string) => {
    const text = (customPrompt ?? input).trim();
    if (!text || !activeSession || streaming) return;

    setStreamError(null);
    setContextTrimmed(false);
    const now = Date.now();
    const userMsg: ChatMessage = {
      id: `msg-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      createdAt: now,
      attachments: attachments.length > 0 ? [...attachments] : undefined,
    };

    const assistantMsgId = `msg-${crypto.randomUUID()}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      model: runtimeConfig.selectedModel,
      createdAt: now + 1,
    };

    const nextTitle =
      activeSession.messages.length <= 1
        ? text.slice(0, 42) + (text.length > 42 ? '…' : '')
        : activeSession.title;

    const historyWithUser = [...activeSession.messages, userMsg];
    const baseSession: ChatSession = {
      ...activeSession,
      title: nextTitle,
      messages: [...historyWithUser, assistantMsg],
      updatedAt: now,
    };

    // Persist the user message once up front; stream tokens in-memory to avoid IDB/AES thrashing.
    await onUpdateSession(baseSession, { immediate: true });
    if (!customPrompt) setInput('');
    const usedAttachments = [...attachments];
    setAttachments([]);
    setShowAttachDrawer(false);

    const controller = new AbortController();
    abortRef.current = controller;
    latestDraftRef.current = '';
    latestThinkingRef.current = '';
    setStreamingDraft({ msgId: assistantMsgId, text: '' });
    setThinkingText('');
    setModelLoaded(false);
    setStreaming(true);
    const startedAt = performance.now();

    try {
      const built = buildGemmaMessages(
        runtimeConfig.systemPrompt,
        historyWithUser,
        resolveContextBlocks(usedAttachments),
        {
          contextTokens: runtimeConfig.contextTokens,
          reserveForReply: runtimeConfig.maxTokens + thinkingHeadroom(runtimeConfig),
        }
      );
      if (built.truncated) {
        setContextTrimmed(true);
      }

      const finalText = await streamLocalGemmaChat({
        config: runtimeConfig,
        messages: built.messages,
        transportHint: probe.transport,
        signal: controller.signal,
        onFirstByte: () => setModelLoaded(true),
        onThinking: (t) => {
          latestThinkingRef.current = t;
          setThinkingText(t);
        },
        onToken: (partial) => {
          latestDraftRef.current = partial;
          setStreamingDraft({ msgId: assistantMsgId, text: partial });
        },
      });

      const elapsed = Math.round(performance.now() - startedAt);
      const savedThinking = latestThinkingRef.current.trim() || undefined;
      const completedSession: ChatSession = {
        ...baseSession,
        messages: baseSession.messages.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: finalText || 'Empty response returned by local Gemma model.',
                thinking: savedThinking,
                durationMs: elapsed,
              }
            : m
        ),
        updatedAt: Date.now(),
      };
      await onUpdateSession(completedSession, { immediate: true });
    } catch (err) {
      const isAbort =
        Boolean(err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError');
      const partial = latestDraftRef.current.trim();
      const savedThinking = latestThinkingRef.current.trim() || undefined;
      if (isAbort) {
        const stoppedSession: ChatSession = {
          ...baseSession,
          messages: partial
            ? baseSession.messages.map((m) =>
                m.id === assistantMsgId ? { ...m, content: partial, thinking: savedThinking } : m
              )
            : baseSession.messages.filter((m) => m.id !== assistantMsgId),
          updatedAt: Date.now(),
        };
        await onUpdateSession(stoppedSession, { immediate: true });
      } else {
        const message =
          err instanceof Error
            ? err.message
            : 'Unable to reach local Google Gemma runtime.';
        setStreamError(message);
        const cleanedSession: ChatSession = {
          ...baseSession,
          messages: partial
            ? baseSession.messages.map((m) =>
                m.id === assistantMsgId ? { ...m, content: partial, thinking: savedThinking } : m
              )
            : baseSession.messages.filter((m) => m.id !== assistantMsgId),
          updatedAt: Date.now(),
        };
        await onUpdateSession(cleanedSession, { immediate: true });
      }
    } finally {
      abortRef.current = null;
      latestDraftRef.current = '';
      latestThinkingRef.current = '';
      setStreamingDraft(null);
      setThinkingText('');
      setModelLoaded(false);
      setStreaming(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 dark:bg-[#0B1120]">
      {/* Runtime Status & Session Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/70">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-xs">
            <Cpu
              className={`h-4 w-4 shrink-0 ${
                probe.connected
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            />
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100">
              {runtimeConfig.selectedModel}
            </span>
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            <span
              className={
                probe.connected
                  ? 'font-medium text-teal-700 dark:text-teal-400'
                  : 'text-slate-500 dark:text-slate-400'
              }
            >
              {probe.connected
                ? `Local ${runtimeConfig.kind === 'ollama' ? 'Ollama' : 'Server'} Connected`
                : 'Local Runtime Offline'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {sessions.length > 1 && (
            <select
              aria-label="Select chat session"
              value={activeSession?.id || ''}
              onChange={(e) => onSelectSession(e.target.value)}
              className="min-h-[36px] max-w-[160px] truncate rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={onCreateSession}
            aria-label="New coding chat"
            className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>

          {sessions.length > 1 && activeSession && (
            <button
              type="button"
              onClick={handleDeleteCurrentSession}
              aria-label="Delete current chat"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-red-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          <button
            type="button"
            onClick={onRescanRuntime}
            disabled={probing}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${probing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Scan Local</span>
          </button>

          <button
            type="button"
            onClick={onOpenRuntimeModal}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Model Setup</span>
          </button>
        </div>
      </div>

      {/* Chat Feed */}
      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {!probe.connected && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900/70">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Connect Your Local Google Gemma Model
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                    Run free open-weight Gemma 4, Gemma 3n, Gemma 3, or CodeGemma completely offline via Ollama (<code className="font-mono">127.0.0.1:11434</code>) or llama.cpp / LM Studio (<code className="font-mono">127.0.0.1:1234</code>).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onOpenRuntimeModal}
                  className="min-h-[38px] rounded-lg bg-teal-600 px-3.5 text-xs font-medium text-white hover:bg-teal-500 whitespace-nowrap shrink-0"
                >
                  Configure Runtime
                </button>
              </div>
              <div className="mt-3 overflow-x-auto rounded-xl bg-slate-100 px-3.5 py-2.5 font-mono text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
                npm run setup:gemma
              </div>
              <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                Safe to re-run: it skips Ollama and any model you already have, and only downloads what is missing.
              </p>
            </div>
          )}

          {contextTrimmed && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-800 dark:text-amber-300">
              Attached context or older turns were trimmed to fit the local Gemma context window budget.
            </div>
          )}

          {activeSession?.messages.map((msg) => {
            const isStreamingThis = streamingDraft && streamingDraft.msgId === msg.id;
            const displayContent = isStreamingThis ? streamingDraft.text : msg.content;
            const displayThinking = isStreamingThis ? thinkingText : msg.thinking || '';

            return (
              <article
                key={msg.id}
                className={`rounded-2xl border p-4 sm:p-5 ${
                  msg.role === 'user'
                    ? 'ml-auto max-w-[92%] border-teal-600/25 bg-teal-50/60 dark:border-teal-500/20 dark:bg-teal-950/20'
                    : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70'
                }`}
              >
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {msg.role === 'user' ? 'Developer' : msg.model || runtimeConfig.selectedModel}
                  </span>
                  <span className="tabular-nums">
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {msg.durationMs ? ` · ${(msg.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </div>

                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-teal-700 dark:text-teal-400">
                    {msg.attachments.map((att) => (
                      <span key={`${att.kind}-${att.id}`} className="font-mono">
                        @{att.kind}:{att.title}
                      </span>
                    ))}
                  </div>
                )}

                {msg.role === 'user' ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-900 dark:text-slate-100">
                    {displayContent}
                  </p>
                ) : displayContent ? (
                  <div className="space-y-3">
                    {displayThinking && (
                      <details className="rounded-lg border border-slate-200 p-2 font-mono text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <summary className="cursor-pointer select-none">Show reasoning</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                          {displayThinking}
                        </pre>
                      </details>
                    )}
                    <MarkdownRenderer
                      content={displayContent}
                      onSaveSnippet={onSaveSnippetFromCode}
                    />
                  </div>
                ) : isStreamingThis ? (
                  <div className="space-y-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                    <p>
                      {!modelLoaded
                        ? `Loading model into memory… ${waitSeconds}s (first request after idle can take a minute)`
                        : thinkingText
                          ? `Reasoning… ${waitSeconds}s`
                          : `Generating… ${waitSeconds}s`}
                    </p>
                    {thinkingText && (
                      <details className="rounded-lg border border-slate-200 p-2 dark:border-slate-800">
                        <summary className="cursor-pointer select-none">Show reasoning</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
                          {thinkingText}
                        </pre>
                      </details>
                    )}
                  </div>
                ) : (
                  <p className="font-mono text-xs text-amber-600 dark:text-amber-400">
                    No response was saved for this message (the request was interrupted). Send it again.
                  </p>
                )}
              </article>
            );
          })}

          {streamError && (
            <div
              role="alert"
              className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-xs leading-relaxed text-red-700 dark:text-red-300"
            >
              <strong>Local Inference Error:</strong> {streamError}. Verify that Ollama or llama.cpp is running locally with model <code className="font-mono">{runtimeConfig.selectedModel}</code>.
            </div>
          )}

          {activeSession && activeSession.messages.length <= 1 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {CODING_STARTERS.map((starter) => (
                <button
                  key={starter.label}
                  type="button"
                  onClick={() => setInput(starter.prompt)}
                  className="rounded-xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:border-teal-500/40 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:bg-slate-800/60"
                >
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {starter.label}
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                    {starter.prompt}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 bg-white p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto max-w-3xl space-y-2.5">
          {showAttachDrawer && (
            <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
              <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <span>Attach Local Snippets or Docs to Gemma Context</span>
                <button
                  type="button"
                  onClick={() => setShowAttachDrawer(false)}
                  aria-label="Close attachment drawer"
                  className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {snippets.map((s) => {
                  const active = attachments.some((a) => a.kind === 'snippet' && a.id === s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        toggleAttachment({ kind: 'snippet', id: s.id, title: s.title })
                      }
                      className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-2.5 text-left text-xs ${
                        active
                          ? 'border-teal-600 bg-teal-500/10 text-teal-800 dark:text-teal-300'
                          : 'border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
                      }`}
                    >
                      <Code2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{s.title}</span>
                    </button>
                  );
                })}
                {docs.map((d) => {
                  const active = attachments.some((a) => a.kind === 'doc' && a.id === d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() =>
                        toggleAttachment({ kind: 'doc', id: d.id, title: d.title })
                      }
                      className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-2.5 text-left text-xs ${
                        active
                          ? 'border-teal-600 bg-teal-500/10 text-teal-800 dark:text-teal-300'
                          : 'border-slate-200 bg-white text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
                      }`}
                    >
                      <BookOpen className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{d.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>Context:</span>
              {attachments.map((att) => (
                <button
                  key={`${att.kind}-${att.id}`}
                  type="button"
                  onClick={() => toggleAttachment(att)}
                  className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-slate-200 bg-slate-100 px-2 py-1 font-mono text-[11px] hover:text-red-600 dark:border-slate-800 dark:bg-slate-800 dark:hover:text-red-400"
                >
                  {att.title} ×
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setShowAttachDrawer((v) => !v)}
              aria-label="Attach local context"
              className={`flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border transition-colors ${
                showAttachDrawer || attachments.length > 0
                  ? 'border-teal-600/40 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                  : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <Paperclip className="h-4 w-4" />
            </button>

            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask local Gemma to write, debug, refactor, or explain code..."
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />

            {streaming ? (
              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop generation"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl bg-red-600 text-white hover:bg-red-500"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSend()}
                disabled={!input.trim()}
                aria-label="Send prompt to local Gemma"
                className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl bg-teal-600 text-white transition-colors hover:bg-teal-500 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

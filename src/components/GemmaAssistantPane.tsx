import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Code2,
  Cpu,
  ExternalLink,
  GitBranch,
  MessageSquarePlus,
  FilePenLine,
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
import { compactConversation } from '../lib/compaction';
import { hashText } from '../lib/editEngine';
import {
  EDIT_INSTRUCTION_BLOCK,
  MAX_AUTO_REPAIRS,
  buildProposalFromReply,
  repairPromptFor,
} from '../lib/editProposal';
import { inputBudgetTokens, planCompaction } from '../lib/contextEngine';
import { estimateMessagesTokens, estimateTokens, getCalibration, recordCalibrationSample } from '../lib/tokenEstimate';
import {
  extractSnippetSnapshotFromSentContext,
  inferActionKindFromPrompt,
  shouldAutoSaveChildSnippets,
} from '../lib/snippetLineage';
import type {
  ChatAttachmentRef,
  ChatMessage,
  ChatSession,
  CodeSnippet,
  DocPage,
  EditTarget,
  GenerationStats,
  LocalRuntimeConfig,
  SavedSnippetRef,
  SnippetActionKind,
  SupportedLanguage,
} from '../types/vault';
import { ChatThreadJumpRail, extractConversationTurns } from './ChatThreadJumpRail';
import { CodeBlock } from './CodeBlock';
import { ContextBar } from './ContextBar';
import { EditProposalCard, type ApplyEditArgs, type SaveVersionArgs } from './EditProposalCard';
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
  onSaveSnippetFromCode: (
    code: string,
    language: SupportedLanguage,
    parentSnippetId?: string,
    actionKind?: SnippetActionKind
  ) => Promise<void>;
  onSaveGeneratedSnippets: (input: {
    parentSnippetId: string;
    actionKind: SnippetActionKind;
    prompt: string;
    model?: string;
    assistantMarkdown: string;
  }) => Promise<SavedSnippetRef[]>;
  onOpenSnippet?: (snippetId: string) => void;
  /** Overwrites a snippet's code if it still matches `expectedHash` (Edit mode "Apply to original"). */
  onApplyEditToSnippet?: (
    snippetId: string,
    newCode: string,
    expectedHash: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Saves edited code as a new child version of a snippet (Edit mode "Save as new version"). */
  onSaveEditAsVersion?: (input: {
    parentSnippetId: string;
    newCode: string;
    prompt: string;
    model?: string;
  }) => Promise<SavedSnippetRef | null>;
  queuedPrompt?: {
    prompt: string;
    attachments: ChatAttachmentRef[];
    actionKind?: SnippetActionKind;
  } | null;
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

const isAbortError = (err: unknown): boolean =>
  Boolean(err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError');

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
  onSaveGeneratedSnippets,
  onOpenSnippet,
  onApplyEditToSnippet,
  onSaveEditAsVersion,
  queuedPrompt,
  onClearQueuedPrompt,
}) => {
  const confirm = useConfirm();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachmentRef[]>([]);
  const [pendingActionKind, setPendingActionKind] = useState<SnippetActionKind | undefined>(
    undefined
  );
  const [showAttachDrawer, setShowAttachDrawer] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingDraft, setStreamingDraft] = useState<{ msgId: string; text: string } | null>(
    null
  );
  const [thinkingText, setThinkingText] = useState('');
  const [modelLoaded, setModelLoaded] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [contextTrimmed, setContextTrimmed] = useState(false);
  const [compacting, setCompacting] = useState(false);
  // Follow-up queued after an edit reply whose blocks did not match; sent once the runtime is idle.
  const [pendingRepair, setPendingRepair] = useState<{
    prompt: string;
    attachments: ChatAttachmentRef[];
    attempt: number;
  } | null>(null);
  const [expandedAttachmentKeys, setExpandedAttachmentKeys] = useState<Record<string, boolean>>({});
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestDraftRef = useRef<string>('');
  const latestThinkingRef = useRef<string>('');
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLElement | null>>({});
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || sessions[0] || null,
    [sessions, activeSessionId]
  );

  const conversationTurns = useMemo(
    () => extractConversationTurns(activeSession?.messages || []),
    [activeSession?.messages]
  );

  // Stop any in-flight local stream if the pane unmounts (e.g. vault auto-lock) so a late
  // completion can never write decrypted chat content after the key has been cleared.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  useEffect(() => {
    setActiveTurnId(conversationTurns[conversationTurns.length - 1]?.id || null);
  }, [activeSession?.id, conversationTurns]);

  // Elapsed-time ticker so a slow cold start is visible instead of looking frozen.
  useEffect(() => {
    if (!streaming && !compacting) {
      setWaitSeconds(0);
      return;
    }
    const id = setInterval(() => setWaitSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [streaming, compacting]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages.length, streaming]);

  useEffect(() => {
    if (queuedPrompt) {
      setInput(queuedPrompt.prompt);
      setAttachments(queuedPrompt.attachments);
      setPendingActionKind(queuedPrompt.actionKind);
      onClearQueuedPrompt();
    }
  }, [queuedPrompt, onClearQueuedPrompt]);

  const toggleAttachmentPreview = (key: string) => {
    setExpandedAttachmentKeys((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleChatScroll = () => {
    if (scrollRafRef.current !== null || conversationTurns.length === 0) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const container = scrollContainerRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const threshold = containerTop + Math.min(220, container.clientHeight * 0.35);
      let current = conversationTurns[0].id;
      for (const turn of conversationTurns) {
        const el = messageRefs.current[turn.id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= threshold) {
          current = turn.id;
        } else {
          break;
        }
      }
      setActiveTurnId((prev) => (prev === current ? prev : current));
    });
  };

  const handleJumpToTurn = (messageId: string) => {
    setActiveTurnId(messageId);
    const el = messageRefs.current[messageId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setHighlightedTurnId(messageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedTurnId((curr) => (curr === messageId ? null : curr));
      highlightTimerRef.current = null;
    }, 1500);
  };

  const toggleAttachment = (ref: ChatAttachmentRef) => {
    setAttachments((prev) => {
      const exists = prev.some((a) => a.kind === ref.kind && a.id === ref.id);
      const next = exists
        ? prev.filter((a) => !(a.kind === ref.kind && a.id === ref.id))
        : [...prev, ref];
      if (!next.some((a) => a.kind === 'snippet')) {
        setPendingActionKind(undefined);
      }
      return next;
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

  // Edit mode: the reply is read as SEARCH/REPLACE blocks to review, not as code to save wholesale.
  const editMode = pendingActionKind === 'edit' && attachments.some((a) => a.kind === 'snippet');

  const promptBudget = useMemo(
    () => ({
      contextTokens: runtimeConfig.contextTokens,
      reserveForReply: runtimeConfig.maxTokens + thinkingHeadroom(runtimeConfig),
    }),
    [runtimeConfig]
  );

  // Live estimate of what the next request would use (typed text is deferred to keep typing smooth).
  const deferredInput = useDeferredValue(input);
  const livePreview = useMemo(() => {
    if (!activeSession) return null;
    const draftMessage: ChatMessage = { id: 'draft', role: 'user', content: deferredInput, createdAt: 0 };
    return buildGemmaMessages(
      runtimeConfig.systemPrompt,
      [...activeSession.messages, draftMessage],
      editMode ? [EDIT_INSTRUCTION_BLOCK, ...resolveContextBlocks(attachments)] : resolveContextBlocks(attachments),
      promptBudget,
      { summary: activeSession.summary, calibration: getCalibration(runtimeConfig.selectedModel) }
    ).usage;
  }, [activeSession, deferredInput, attachments, editMode, runtimeConfig, promptBudget, snippets, docs]);

  const lastStats = useMemo(() => {
    const msgs = activeSession?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].stats) return msgs[i].stats;
    }
    return undefined;
  }, [activeSession]);

  const persistSummary = (summary: ChatSession['summary']) => {
    if (!activeSession) return;
    void onUpdateSession({ ...activeSession, summary, updatedAt: Date.now() }, { immediate: true });
  };

  const handleSaveSummary = (text: string) => {
    if (!activeSession?.summary || !text.trim()) return;
    persistSummary({ ...activeSession.summary, text: text.trim(), edited: true, updatedAt: Date.now() });
  };

  const handleCompactNow = async () => {
    if (!activeSession || streaming || compacting) return;
    const calibration = getCalibration(runtimeConfig.selectedModel);
    const plan = planCompaction(
      activeSession.messages,
      activeSession.summary,
      inputBudgetTokens(promptBudget),
      calibration.scale,
      { force: true }
    );
    if (!plan) {
      setStreamError('Nothing to condense yet: keep chatting and try again once there are a few turns.');
      return;
    }
    setStreamError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setCompacting(true);
    try {
      const text = await compactConversation({
        config: runtimeConfig,
        previous: activeSession.summary,
        messages: plan.fold,
        signal: controller.signal,
        transportHint: probe.transport,
        calibrationScale: calibration.scale,
      });
      persistSummary({
        text,
        coversUpToMessageId: plan.coversUpToMessageId,
        updatedAt: Date.now(),
        model: runtimeConfig.selectedModel,
      });
    } catch (err) {
      if (!isAbortError(err)) {
        setStreamError(`Could not condense the chat: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    } finally {
      abortRef.current = null;
      setCompacting(false);
    }
  };

  // --- Edit proposals -------------------------------------------------------------------------

  const precedingUserOf = (msgId: string): ChatMessage | undefined => {
    const msgs = activeSession?.messages ?? [];
    for (let k = msgs.findIndex((m) => m.id === msgId) - 1; k >= 0; k--) {
      if (msgs[k].role === 'user') return msgs[k];
    }
    return undefined;
  };

  const updateEditTarget = async (msgId: string, targetIndex: number, patch: Partial<EditTarget>) => {
    if (!activeSession) return;
    await onUpdateSession(
      {
        ...activeSession,
        messages: activeSession.messages.map((m) =>
          m.id === msgId && m.edits
            ? { ...m, edits: { ...m.edits, targets: m.edits.targets.map((t, i) => (i === targetIndex ? { ...t, ...patch } : t)) } }
            : m
        ),
        updatedAt: Date.now(),
      },
      { immediate: true }
    );
  };

  const handleApplyEdit = async (msg: ChatMessage, targetIndex: number, args: ApplyEditArgs) => {
    const target = msg.edits?.targets[targetIndex];
    const snippet = target && snippets.find((s) => s.id === target.snippetId);
    if (!target || !snippet || !onApplyEditToSnippet) return;
    const res = await onApplyEditToSnippet(target.snippetId, args.newCode, args.expectedHash);
    if (!res.ok) {
      setStreamError(res.reason);
      return;
    }
    setStreamError(null);
    await updateEditTarget(msg.id, targetIndex, {
      state: 'applied',
      acceptedHunkIds: args.acceptedHunkIds,
      preImage: snippet.code,
      postHash: hashText(args.newCode),
      resolvedAt: Date.now(),
    });
  };

  const handleSaveEditVersion = async (msg: ChatMessage, targetIndex: number, args: SaveVersionArgs) => {
    const target = msg.edits?.targets[targetIndex];
    if (!target || !onSaveEditAsVersion) return;
    const ref = await onSaveEditAsVersion({
      parentSnippetId: target.snippetId,
      newCode: args.newCode,
      prompt: precedingUserOf(msg.id)?.content ?? '',
      model: msg.model,
    });
    if (!ref) {
      setStreamError('Could not save the new version: the original snippet no longer exists.');
      return;
    }
    setStreamError(null);
    await updateEditTarget(msg.id, targetIndex, {
      state: 'saved',
      acceptedHunkIds: args.acceptedHunkIds,
      resultSnippetId: ref.id,
      resolvedAt: Date.now(),
    });
  };

  const handleUndoEdit = async (msg: ChatMessage, targetIndex: number) => {
    const target = msg.edits?.targets[targetIndex];
    const snippet = target && snippets.find((s) => s.id === target.snippetId);
    if (!target || !snippet || !onApplyEditToSnippet || target.preImage === undefined || !target.postHash) return;
    if (hashText(snippet.code) !== target.postHash) {
      setStreamError('Cannot undo: the snippet was changed after this edit.');
      return;
    }
    const res = await onApplyEditToSnippet(target.snippetId, target.preImage, target.postHash);
    if (!res.ok) {
      setStreamError(res.reason);
      return;
    }
    setStreamError(null);
    await updateEditTarget(msg.id, targetIndex, {
      state: 'pending',
      acceptedHunkIds: undefined,
      preImage: undefined,
      postHash: undefined,
      resolvedAt: undefined,
    });
  };

  const handleRepairClick = (msg: ChatMessage) => {
    if (!msg.edits) return;
    const refs = (precedingUserOf(msg.id)?.attachments ?? []).filter((a) => a.kind === 'snippet');
    const current = refs.map((r) => snippets.find((s) => s.id === r.id)).filter((s): s is CodeSnippet => Boolean(s));
    const prompt = repairPromptFor(msg.edits, current);
    if (prompt) setPendingRepair({ prompt, attachments: refs, attempt: msg.edits.attempt + 1 });
  };

  useEffect(() => {
    if (!pendingRepair || streaming || compacting) return;
    const repair = pendingRepair;
    setPendingRepair(null);
    void handleSend(repair.prompt, { attachments: repair.attachments, actionKind: 'edit', attempt: repair.attempt });
    // handleSend is recreated every render; the latest one is used when this effect fires.
  }, [pendingRepair, streaming, compacting]);

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

  const handleSend = async (
    customPrompt?: string,
    opts?: { attachments?: ChatAttachmentRef[]; actionKind?: SnippetActionKind; attempt?: number }
  ) => {
    const text = (customPrompt ?? input).trim();
    if (!text || !activeSession || streaming || compacting) return;

    setStreamError(null);
    setContextTrimmed(false);
    const now = Date.now();
    const usedAttachments = [...(opts?.attachments ?? attachments)];
    const primarySnippetAttachment = usedAttachments.find((a) => a.kind === 'snippet');
    const resolvedActionKind = primarySnippetAttachment
      ? inferActionKindFromPrompt(text, opts?.actionKind ?? pendingActionKind)
      : undefined;
    const isEditTurn = resolvedActionKind === 'edit';
    const editAttempt = opts?.attempt ?? 0;

    const userMsg: ChatMessage = {
      id: `msg-${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      createdAt: now,
      attachments: usedAttachments.length > 0 ? usedAttachments : undefined,
      actionKind: resolvedActionKind,
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
    // An automatic follow-up must not wipe what the user is composing meanwhile.
    if (!opts?.attachments) {
      setAttachments([]);
      setPendingActionKind(undefined);
    }
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
    const statsBox: { current?: GenerationStats } = {};
    // Session as last persisted; later saves build on it so the stored context/summary are never lost.
    let workingSession = baseSession;

    try {
      const calibration = getCalibration(runtimeConfig.selectedModel);
      let summary = activeSession.summary;

      // Once the chat outgrows its history budget, fold the oldest turns into the summary note
      // (best effort: on failure we simply continue and the builder drops what does not fit).
      if (runtimeConfig.autoCompact !== false) {
        const plan = planCompaction(
          activeSession.messages,
          summary,
          inputBudgetTokens(promptBudget),
          calibration.scale
        );
        if (plan) {
          setCompacting(true);
          try {
            const text = await compactConversation({
              config: runtimeConfig,
              previous: summary,
              messages: plan.fold,
              signal: controller.signal,
              transportHint: probe.transport,
              calibrationScale: calibration.scale,
            });
            summary = {
              text,
              coversUpToMessageId: plan.coversUpToMessageId,
              updatedAt: Date.now(),
              model: runtimeConfig.selectedModel,
            };
          } catch (compactErr) {
            if (isAbortError(compactErr)) throw compactErr;
          } finally {
            setCompacting(false);
          }
        }
      }

      const built = buildGemmaMessages(
        runtimeConfig.systemPrompt,
        historyWithUser,
        isEditTurn ? [EDIT_INSTRUCTION_BLOCK, ...resolveContextBlocks(usedAttachments)] : resolveContextBlocks(usedAttachments),
        promptBudget,
        { summary, calibration }
      );
      if (built.truncated) {
        setContextTrimmed(true);
      }

      // Remember exactly what was sent with this message so later turns replay it identically.
      workingSession = {
        ...baseSession,
        summary,
        messages: baseSession.messages.map((m) =>
          m.id === userMsg.id ? { ...m, sentContext: built.sentContext || undefined } : m
        ),
      };
      await onUpdateSession(workingSession, { immediate: true });

      const finalText = await streamLocalGemmaChat({
        // Exact quoting matters more than variety when proposing SEARCH/REPLACE edits.
        config: isEditTurn
          ? { ...runtimeConfig, temperature: Math.min(runtimeConfig.temperature, 0.2) }
          : runtimeConfig,
        messages: built.messages,
        transportHint: probe.transport,
        signal: controller.signal,
        onStats: (stats) => {
          statsBox.current = stats;
        },
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
      const measured = statsBox.current;
      if (measured) {
        // Teach the estimator how this model really tokenises (prompt-side cache hits are ignored).
        if (measured.promptTokens) {
          recordCalibrationSample(runtimeConfig.selectedModel, {
            estimatedTokens: estimateMessagesTokens(built.messages, 1),
            observedTokens: measured.promptTokens,
            promptSide: true,
          });
        }
        if (measured.completionTokens) {
          recordCalibrationSample(runtimeConfig.selectedModel, {
            estimatedTokens: estimateTokens(`${finalText}\n${latestThinkingRef.current}`, 1),
            observedTokens: measured.completionTokens,
          });
        }
      }
      const editSnippets = usedAttachments
        .filter((a) => a.kind === 'snippet')
        .map((a) => snippets.find((s) => s.id === a.id))
        .filter((s): s is CodeSnippet => Boolean(s));
      const editProposal =
        isEditTurn && finalText.trim()
          ? buildProposalFromReply({ reply: finalText, snippets: editSnippets, attempt: editAttempt })
          : null;
      // An edit reply with no SEARCH/REPLACE blocks (plain code) falls back to saving it as a version.
      const autoSave = isEditTurn ? !editProposal : shouldAutoSaveChildSnippets(resolvedActionKind || 'chat');
      const savedSnippets =
        primarySnippetAttachment &&
        finalText.trim() &&
        autoSave
          ? await onSaveGeneratedSnippets({
              parentSnippetId: primarySnippetAttachment.id,
              actionKind: resolvedActionKind || 'chat',
              prompt: text,
              model: runtimeConfig.selectedModel,
              assistantMarkdown: finalText,
            })
          : [];

      const completedSession: ChatSession = {
        ...workingSession,
        messages: workingSession.messages.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: finalText || 'Empty response returned by local Gemma model.',
                thinking: savedThinking,
                durationMs: elapsed,
                stats: measured,
                edits: editProposal ?? undefined,
                savedSnippets: savedSnippets.length > 0 ? savedSnippets : undefined,
              }
            : m
        ),
        updatedAt: Date.now(),
      };
      await onUpdateSession(completedSession, { immediate: true });

      // Blocks that did not match (or a cut-off reply): ask once, automatically, for just those blocks.
      if (editProposal && editAttempt < MAX_AUTO_REPAIRS) {
        const repair = repairPromptFor(editProposal, editSnippets);
        if (repair) {
          setPendingRepair({
            prompt: repair,
            attachments: usedAttachments.filter((a) => a.kind === 'snippet'),
            attempt: editAttempt + 1,
          });
        }
      }
    } catch (err) {
      const isAbort =
        Boolean(err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'AbortError');
      const partial = latestDraftRef.current.trim();
      const savedThinking = latestThinkingRef.current.trim() || undefined;
      if (isAbort) {
        const stoppedSession: ChatSession = {
          ...workingSession,
          messages: partial
            ? workingSession.messages.map((m) =>
                m.id === assistantMsgId ? { ...m, content: partial, thinking: savedThinking } : m
              )
            : workingSession.messages.filter((m) => m.id !== assistantMsgId),
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
          ...workingSession,
          messages: partial
            ? workingSession.messages.map((m) =>
                m.id === assistantMsgId ? { ...m, content: partial, thinking: savedThinking } : m
              )
            : workingSession.messages.filter((m) => m.id !== assistantMsgId),
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
      setCompacting(false);
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

          <div className="group/newchat relative inline-flex">
            <button
              type="button"
              onClick={onCreateSession}
              aria-label="New coding chat"
              aria-describedby="new-coding-chat-tooltip"
              className="flex min-h-[36px] min-w-[36px] cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition-colors hover:border-teal-500/50 hover:bg-teal-50/70 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-teal-500/40 dark:hover:bg-teal-950/40 dark:hover:text-teal-300"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
            <div
              id="new-coding-chat-tooltip"
              role="tooltip"
              className="pointer-events-none invisible absolute top-full left-0 z-30 mt-2 w-56 rounded-xl border border-slate-700/80 bg-slate-900/95 px-3 py-2 text-left text-[11px] leading-snug text-slate-100 opacity-0 shadow-xl backdrop-blur-md transition-opacity duration-150 group-hover/newchat:visible group-hover/newchat:opacity-100 group-focus-within/newchat:visible group-focus-within/newchat:opacity-100 sm:left-1/2 sm:-translate-x-1/2 dark:border-slate-600/80 dark:bg-slate-950/95"
            >
              <div className="font-semibold text-white">New coding chat</div>
              <p className="mt-0.5 text-slate-300">
                Start a fresh conversation thread with local Gemma while keeping your existing chats saved.
              </p>
            </div>
          </div>

          {sessions.length > 1 && activeSession && (
            <button
              type="button"
              onClick={handleDeleteCurrentSession}
              aria-label="Delete current chat"
              title="Delete current chat session"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-red-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}

          <button
            type="button"
            onClick={onRescanRuntime}
            disabled={probing}
            title="Scan local runtime endpoints for available Gemma models"
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${probing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Scan Local</span>
          </button>

          <button
            type="button"
            onClick={onOpenRuntimeModal}
            title="Configure local Gemma runtime, model, and prompt budget"
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Model Setup</span>
          </button>
        </div>
      </div>

      {/* Chat Feed + DeepSeek-style Right-Edge Jump Chip */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollContainerRef}
          onScroll={handleChatScroll}
          className="flex-1 overflow-y-auto px-4 py-5 pr-7 sm:px-6 sm:pr-9"
        >
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

            {activeSession?.messages.map((msg, msgIndex) => {
              const isStreamingThis = streamingDraft && streamingDraft.msgId === msg.id;
              const displayContent = isStreamingThis ? streamingDraft.text : msg.content;
              const displayThinking = isStreamingThis ? thinkingText : msg.thinking || '';
              const precedingUser =
                msg.role === 'assistant' && msgIndex > 0
                  ? activeSession.messages[msgIndex - 1]
                  : undefined;
              const turnParentSnippetId = precedingUser?.attachments?.find(
                (a) => a.kind === 'snippet'
              )?.id;
              const turnActionKind = precedingUser?.actionKind;
              const isJumpedHighlight = highlightedTurnId === msg.id;

              return (
                <article
                  key={msg.id}
                  id={`chat-msg-${msg.id}`}
                  ref={(el) => {
                    messageRefs.current[msg.id] = el;
                  }}
                  className={`scroll-mt-4 rounded-2xl border p-4 transition-shadow sm:p-5 ${
                    msg.role === 'user'
                      ? 'ml-auto max-w-[92%] border-teal-600/25 bg-teal-50/60 dark:border-teal-500/20 dark:bg-teal-950/20'
                      : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70'
                  } ${isJumpedHighlight ? 'ring-2 ring-teal-500/70 ring-offset-2 ring-offset-slate-50 dark:ring-offset-[#0B1120]' : ''}`}
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
                    {msg.stats?.tokensPerSecond ? ` · ${msg.stats.tokensPerSecond} tok/s` : ''}
                  </span>
                </div>

                {msg.attachments && msg.attachments.length > 0 && (() => {
                  const expandedPreviews: Array<{
                    key: string;
                    snippetId: string;
                    title: string;
                    language: SupportedLanguage;
                    code: string;
                    version?: number;
                    deleted: boolean;
                    truncated?: boolean;
                  }> = [];

                  return (
                    <div className="mb-2.5 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {msg.attachments.map((att) => {
                          if (att.kind !== 'snippet') {
                            return (
                              <span
                                key={`${att.kind}-${att.id}`}
                                className="font-mono text-teal-700 dark:text-teal-400"
                              >
                                @{att.kind}:{att.title}
                              </span>
                            );
                          }

                          const liveSnippet = snippets.find((s) => s.id === att.id);
                          const expandKey = `${msg.id}:${att.id}`;
                          const isExpanded = Boolean(expandedAttachmentKeys[expandKey]);

                          if (liveSnippet) {
                            const displayTitle = liveSnippet.title || att.title;
                            const tooltip =
                              liveSnippet.title !== att.title
                                ? `Open "${liveSnippet.title}" in Snippets (attached as "${att.title}")`
                                : `Open "${displayTitle}" in Snippets`;

                            if (isExpanded) {
                              expandedPreviews.push({
                                key: expandKey,
                                snippetId: liveSnippet.id,
                                title: displayTitle,
                                language: liveSnippet.language,
                                code: liveSnippet.code,
                                version: liveSnippet.version,
                                deleted: false,
                              });
                            }

                            return (
                              <span
                                key={`${att.kind}-${att.id}`}
                                className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-teal-600/25 bg-teal-500/10 px-2 py-1 text-teal-700 dark:border-teal-500/25 dark:bg-teal-500/10 dark:text-teal-300"
                              >
                                {onOpenSnippet ? (
                                  <button
                                    type="button"
                                    onClick={() => onOpenSnippet(att.id)}
                                    title={tooltip}
                                    aria-label={`Open snippet ${displayTitle} in Snippets tab`}
                                    className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left font-mono underline decoration-teal-600/50 underline-offset-2 transition-colors hover:text-teal-900 hover:decoration-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:decoration-teal-400/50 dark:hover:text-teal-200 dark:hover:decoration-teal-300"
                                  >
                                    <span className="truncate">
                                      @{att.kind}:{displayTitle}
                                    </span>
                                    <ExternalLink className="h-3 w-3 shrink-0 opacity-75" aria-hidden="true" />
                                  </button>
                                ) : (
                                  <span className="truncate font-mono">
                                    @{att.kind}:{displayTitle}
                                  </span>
                                )}

                                <button
                                  type="button"
                                  onClick={() => toggleAttachmentPreview(expandKey)}
                                  aria-expanded={isExpanded}
                                  aria-controls={`attachment-preview-${expandKey}`}
                                  aria-label={
                                    isExpanded
                                      ? `Collapse full code for ${displayTitle}`
                                      : `Expand full code for ${displayTitle}`
                                  }
                                  title={
                                    isExpanded
                                      ? 'Collapse inline code view'
                                      : 'Expand to view full code snippet on this page'
                                  }
                                  className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 font-sans text-[11px] font-medium text-teal-800 transition-colors hover:bg-teal-600/15 dark:text-teal-200 dark:hover:bg-teal-400/15"
                                >
                                  {isExpanded ? (
                                    <>
                                      <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
                                      Hide code
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                                      View code
                                    </>
                                  )}
                                </button>
                              </span>
                            );
                          }

                          const snapshot = extractSnippetSnapshotFromSentContext(msg.sentContext, att.title);
                          if (snapshot && isExpanded) {
                            expandedPreviews.push({
                              key: expandKey,
                              snippetId: att.id,
                              title: att.title,
                              language: snapshot.language,
                              code: snapshot.code,
                              deleted: true,
                              truncated: snapshot.truncated,
                            });
                          }

                          return (
                            <span
                              key={`${att.kind}-${att.id}`}
                              className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/10 px-2 py-1 text-rose-800 dark:border-rose-400/30 dark:bg-rose-950/40 dark:text-rose-300"
                              title={`Source snippet "${att.title}" was deleted from the Snippets tab`}
                            >
                              <Trash2
                                className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400"
                                aria-label="Deleted snippet"
                              />
                              <span className="truncate font-mono line-through decoration-rose-500/60">
                                @{att.kind}:{att.title}
                              </span>
                              <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">
                                Deleted
                              </span>
                              {snapshot && (
                                <button
                                  type="button"
                                  onClick={() => toggleAttachmentPreview(expandKey)}
                                  aria-expanded={isExpanded}
                                  aria-controls={`attachment-preview-${expandKey}`}
                                  aria-label={
                                    isExpanded
                                      ? `Collapse captured code snapshot for deleted snippet ${att.title}`
                                      : `Expand captured code snapshot for deleted snippet ${att.title}`
                                  }
                                  title={
                                    isExpanded
                                      ? 'Hide sent code snapshot'
                                      : 'View code snapshot captured when this prompt was sent'
                                  }
                                  className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 font-sans text-[11px] font-medium text-rose-800 transition-colors hover:bg-rose-500/20 dark:text-rose-200"
                                >
                                  {isExpanded ? (
                                    <>
                                      <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
                                      Hide snapshot
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                                      View snapshot
                                    </>
                                  )}
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>

                      {expandedPreviews.length > 0 && (
                        <div className="space-y-2.5">
                          {expandedPreviews.map((item) => (
                            <div
                              key={item.key}
                              id={`attachment-preview-${item.key}`}
                              className={`overflow-hidden rounded-xl border ${
                                item.deleted
                                  ? 'border-rose-500/35 bg-rose-500/5 dark:border-rose-400/25 dark:bg-rose-950/20'
                                  : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 text-xs dark:border-slate-800/80">
                                <div className="flex min-w-0 items-center gap-2">
                                  {item.deleted ? (
                                    <Trash2
                                      className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <Code2
                                      className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400"
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span className="truncate font-mono font-medium text-slate-800 dark:text-slate-200">
                                    {item.title}
                                  </span>
                                  {item.version !== undefined && (
                                    <span className="rounded bg-slate-200/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                      v{item.version}
                                    </span>
                                  )}
                                  {item.deleted && (
                                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">
                                      Deleted from Snippets · Sent snapshot
                                      {item.truncated ? ' (truncated)' : ''}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-3">
                                  {!item.deleted && onOpenSnippet && (
                                    <button
                                      type="button"
                                      onClick={() => onOpenSnippet(item.snippetId)}
                                      className="inline-flex cursor-pointer items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-400"
                                    >
                                      Open in Snippets
                                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => toggleAttachmentPreview(item.key)}
                                    className="inline-flex cursor-pointer items-center gap-1 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                                  >
                                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                                    Collapse
                                  </button>
                                </div>
                              </div>
                              <div className="px-3">
                                <CodeBlock
                                  code={item.code}
                                  language={item.language}
                                  showLineNumbers
                                  onSaveSnippet={
                                    item.deleted
                                      ? (code, language) => void onSaveSnippetFromCode(code, language)
                                      : undefined
                                  }
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

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
                      onSaveSnippet={(code, language) =>
                        void onSaveSnippetFromCode(
                          code,
                          language,
                          turnParentSnippetId,
                          turnActionKind
                        )
                      }
                    />
                    {msg.edits && !isStreamingThis && (
                      <EditProposalCard
                        proposal={msg.edits}
                        snippets={snippets}
                        busy={streaming || compacting || !onApplyEditToSnippet || !onSaveEditAsVersion}
                        onApply={(ti, args) => handleApplyEdit(msg, ti, args)}
                        onSaveVersion={(ti, args) => handleSaveEditVersion(msg, ti, args)}
                        onUndo={(ti) => handleUndoEdit(msg, ti)}
                        onDismiss={(ti) =>
                          void updateEditTarget(msg.id, ti, { state: 'dismissed', resolvedAt: Date.now() })
                        }
                        onRepair={() => handleRepairClick(msg)}
                        onOpenSnippet={onOpenSnippet}
                      />
                    )}
                    {msg.savedSnippets && msg.savedSnippets.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-2.5 text-xs text-slate-600 dark:border-slate-800/80 dark:text-slate-400">
                        <span className="inline-flex items-center gap-1 font-medium text-teal-700 dark:text-teal-400">
                          <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                          Saved to Snippets
                          {msg.savedSnippets[0]?.parentTitle
                            ? ` under "${msg.savedSnippets[0].parentTitle}"`
                            : ''}
                          :
                        </span>
                        {msg.savedSnippets.map((savedRef) => {
                          const liveSaved = snippets.find((s) => s.id === savedRef.id);
                          if (!liveSaved) {
                            return (
                              <span
                                key={savedRef.id}
                                className="inline-flex max-w-full items-center gap-1 rounded-md border border-rose-500/35 bg-rose-500/10 px-2 py-1 font-mono text-[11px] font-medium text-rose-700 dark:border-rose-400/30 dark:bg-rose-950/40 dark:text-rose-300"
                                title={`Derived snippet "${savedRef.title}" was deleted from the Snippets tab`}
                              >
                                <Trash2
                                  className="h-3 w-3 shrink-0 text-rose-600 dark:text-rose-400"
                                  aria-label="Deleted snippet"
                                />
                                <span className="truncate line-through decoration-rose-500/60">
                                  {savedRef.title}
                                </span>
                                <span className="font-sans text-[10px] font-semibold">Deleted</span>
                              </span>
                            );
                          }
                          return (
                            <button
                              key={savedRef.id}
                              type="button"
                              onClick={() => onOpenSnippet?.(savedRef.id)}
                              className="max-w-full truncate rounded-md border border-teal-600/30 bg-teal-500/10 px-2 py-1 font-mono text-[11px] font-medium text-teal-800 hover:bg-teal-500/20 dark:text-teal-300"
                              title={`Open ${liveSaved.title} in Snippets`}
                            >
                              {liveSaved.title}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : isStreamingThis ? (
                  <div className="space-y-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                    <p>
                      {compacting
                        ? `Condensing earlier turns into a summary… ${waitSeconds}s`
                        : !modelLoaded
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

        <ChatThreadJumpRail
          turns={conversationTurns}
          activeTurnId={activeTurnId}
          onJumpToTurn={handleJumpToTurn}
        />
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 bg-white p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto max-w-3xl space-y-2.5">
          <ContextBar
            usage={livePreview}
            lastStats={lastStats}
            summary={activeSession?.summary}
            streaming={streaming}
            compacting={compacting}
            onCompactNow={() => void handleCompactNow()}
            onCancelCompaction={handleStop}
            onSaveSummary={handleSaveSummary}
            onClearSummary={() => persistSummary(undefined)}
          />

          {onSaveEditAsVersion && attachments.some((a) => a.kind === 'snippet') && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                role="switch"
                aria-checked={editMode}
                onClick={() => setPendingActionKind(editMode ? undefined : 'edit')}
                className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border px-2.5 font-medium transition-colors ${
                  editMode
                    ? 'border-teal-600/50 bg-teal-500/15 text-teal-800 dark:text-teal-300'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <FilePenLine className="h-3.5 w-3.5" aria-hidden="true" />
                Edit mode {editMode ? 'on' : 'off'}
              </button>
              {editMode && (
                <span className="text-slate-500 dark:text-slate-400">
                  Gemma proposes small changes you can review, accept per change, apply or undo.
                </span>
              )}
            </div>
          )}

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
              placeholder="Ask your local Gemma model to write, debug, refactor, explain, expand, and test code..."
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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Code2,
  Cpu,
  Database,
  FolderKanban,
  Lock,
  Moon,
  Plus,
  Sun,
  WifiOff,
} from 'lucide-react';
import { ConfirmProvider } from './components/ConfirmDialog';
import { DocsView } from './components/DocsView';
import { GemmaAssistantPane } from './components/GemmaAssistantPane';
import { LocalGemmaSetupModal } from './components/LocalGemmaSetupModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { RuntimeStatusBar } from './components/RuntimeStatusBar';
import { SnippetsView } from './components/SnippetsView';
import { VaultDatabaseView } from './components/VaultDatabaseView';
import { VaultLockScreen } from './components/VaultLockScreen';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useRuntimeStatus } from './hooks/useRuntimeStatus';
import {
  changeVaultPassphrase,
  DEFAULT_RUNTIME_CONFIG,
  disableVaultEncryption,
  enableVaultEncryption,
  exportVaultBackup,
  getSecurityMeta,
  importVaultBackup,
  loadWorkspaceData,
  removeChatSession,
  removeDoc,
  removeProjectAndRehome,
  removeSnippet,
  saveChatSession,
  saveDoc,
  saveProject,
  saveRuntimeConfig,
  saveSnippet,
  unlockVaultWithPassphrase,
  updateSecurityMeta,
  type DecryptedWorkspaceData,
} from './lib/db';
import {
  inspectWebGPU,
  probeLocalGemmaRuntime,
  type ProbeResult,
  type WebGPUStatus,
} from './lib/gemmaClient';
import { createSaveQueue } from './lib/saveQueue';
import {
  createChildSnippets,
  extractFencedCodeBlocks,
} from './lib/snippetLineage';
import { hashText } from './lib/editEngine';
import type {
  ChatAttachmentRef,
  ChatSession,
  CodeSnippet,
  DocPage,
  LocalRuntimeConfig,
  Project,
  SavedSnippetRef,
  SnippetActionKind,
  SupportedLanguage,
  VaultBackupBundle,
  WorkspaceTab,
} from './types/vault';

function AppShell() {
  const isOnline = useOnlineStatus();
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('gemmavault_theme');
    return saved ? saved === 'dark' : true;
  });

  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [workspace, setWorkspace] = useState<DecryptedWorkspaceData | null>(null);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('assistant');
  const [activeProjectId, setActiveProjectId] = useState<string>('all');
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [snippetOpenNonce, setSnippetOpenNonce] = useState(0);
  const [queuedPrompt, setQueuedPrompt] = useState<{
    prompt: string;
    attachments: ChatAttachmentRef[];
    actionKind?: SnippetActionKind;
  } | null>(null);

  const [probe, setProbe] = useState<ProbeResult>({
    connected: false,
    transport: 'none',
    models: [],
    recommendedModel: null,
  });
  const [probing, setProbing] = useState(false);
  const [webgpu, setWebgpu] = useState<WebGPUStatus>({ supported: false });
  const [runtimeModalOpen, setRuntimeModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const lastActivityRef = useRef<number>(Date.now());
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2600);
  }, []);

  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const saveQueueRef = useRef(
    createSaveQueue(350, (err) => {
      const msg = err instanceof Error ? err.message : 'Local database write failed';
      showToastRef.current(`Save failed: ${msg}`);
    })
  );
  const cryptoKeyRef = useRef<CryptoKey | null>(null);
  cryptoKeyRef.current = cryptoKey;
  const workspaceRef = useRef<DecryptedWorkspaceData | null>(null);
  workspaceRef.current = workspace;
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('gemmavault_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Flush pending debounced IndexedDB writes when tab hides or page closes (pagehide works reliably on mobile too)
  useEffect(() => {
    const flushPending = () => {
      void saveQueueRef.current.flushAll();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPending();
      }
    };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const runRuntimeProbe = useCallback(
    async (overrideConfig?: LocalRuntimeConfig, silent = false) => {
      const cfg = overrideConfig || workspace?.runtimeConfig || DEFAULT_RUNTIME_CONFIG;
      if (!silent) setProbing(true);
      try {
        const result = await probeLocalGemmaRuntime(cfg);
        setProbe(result);
        if (result.connected && result.recommendedModel) {
          const hasConfigured = result.models.some((m) => m.id === cfg.selectedModel);
          if (!hasConfigured && workspace) {
            const nextCfg = { ...cfg, selectedModel: result.recommendedModel.id };
            await saveQueueRef.current.now('settings:runtime', () =>
              saveRuntimeConfig(nextCfg, cryptoKeyRef.current)
            );
            setWorkspace((prev) => (prev ? { ...prev, runtimeConfig: nextCfg } : prev));
          }
        }
      } finally {
        if (!silent) setProbing(false);
      }
    },
    [workspace]
  );

  // Always-visible local-LLM status (separate from "the web page loaded"), refreshed in the background.
  const refreshProbeSilently = useCallback(
    () => runRuntimeProbe(undefined, true),
    [runRuntimeProbe]
  );
  const runtimeStatus = useRuntimeStatus({
    config: workspace?.runtimeConfig,
    probe,
    refreshProbe: refreshProbeSilently,
  });

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const meta = await getSecurityMeta();
        if (!mounted) return;
        if (meta.encryptionEnabled) {
          setLocked(true);
        } else {
          const data = await loadWorkspaceData(null);
          if (!mounted) return;
          setWorkspace(data);
          setActiveSessionId(data.sessions[0]?.id || '');
          setSelectedSnippetId(data.snippets[0]?.id || null);
          const probeRes = await probeLocalGemmaRuntime(data.runtimeConfig);
          if (mounted) setProbe(probeRes);
        }
        const gpuInfo = await inspectWebGPU();
        if (mounted) setWebgpu(gpuInfo);
      } catch (err) {
        if (mounted) {
          setBootError(
            err instanceof Error
              ? err.message
              : 'Local database could not be opened in this browser context.'
          );
        }
      } finally {
        if (mounted) setBooting(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const lockVault = useCallback(async (broadcast = true) => {
    await saveQueueRef.current.flushAll();
    setCryptoKey(null);
    setWorkspace(null);
    setLocked(true);
    if (broadcast) channelRef.current?.postMessage('lock');
  }, []);

  // Keep multiple open tabs consistent: locking one tab locks all; changing the vault's
  // encryption state reloads the others so they never write with a stale key or state.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('gemmavault-sync');
    channelRef.current = channel;
    channel.onmessage = (ev: MessageEvent) => {
      if (ev.data === 'lock') {
        if (workspaceRef.current?.securityMeta.encryptionEnabled) void lockVault(false);
      } else if (ev.data === 'security-changed') {
        void saveQueueRef.current.flushAll().finally(() => window.location.reload());
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [lockVault]);

  useEffect(() => {
    const mins = workspace?.securityMeta.autoLockMinutes || 0;
    if (!workspace?.securityMeta.encryptionEnabled || mins <= 0 || locked) return;

    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);

    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current > mins * 60_000) {
        void lockVault();
      }
    }, 15_000);

    return () => {
      window.removeEventListener('pointerdown', bump);
      window.removeEventListener('keydown', bump);
      clearInterval(interval);
    };
  }, [workspace?.securityMeta, locked, lockVault]);

  const handleUnlock = async (passphrase: string): Promise<boolean> => {
    const res = await unlockVaultWithPassphrase(passphrase);
    if (!res) return false;
    const data = await loadWorkspaceData(res.key);
    setCryptoKey(res.key);
    setWorkspace(data);
    setActiveSessionId(data.sessions[0]?.id || '');
    setSelectedSnippetId(data.snippets[0]?.id || null);
    setLocked(false);
    lastActivityRef.current = Date.now();
    probeLocalGemmaRuntime(data.runtimeConfig).then(setProbe);
    return true;
  };

  const handleLockNow = () => {
    if (!workspace?.securityMeta.encryptionEnabled) return;
    void lockVault();
  };

  const handleSaveSnippet = (snippet: CodeSnippet) => {
    setWorkspace((prev) => {
      if (!prev) return prev;
      const exists = prev.snippets.some((s) => s.id === snippet.id);
      const nextSnippets = exists
        ? prev.snippets.map((s) => (s.id === snippet.id ? snippet : s))
        : [snippet, ...prev.snippets];
      return { ...prev, snippets: nextSnippets };
    });
    saveQueueRef.current.schedule(`snip:${snippet.id}`, () =>
      saveSnippet(snippet, cryptoKeyRef.current)
    );
  };

  const handleDeleteSnippet = async (id: string) => {
    const deleted = workspaceRef.current?.snippets.find((s) => s.id === id);
    // Compute re-homed children synchronously from workspaceRef; React may run or
    // re-run state updaters later or twice, making side-effect collection inside them unsafe.
    const now = Date.now();
    const rehomedChildren: CodeSnippet[] = (workspaceRef.current?.snippets ?? [])
      .filter((s) => s.parentId === id)
      .map((s) => ({ ...s, parentId: deleted?.parentId, updatedAt: now }));
    const rehomedById = new Map(rehomedChildren.map((c) => [c.id, c]));

    setWorkspace((prev) =>
      prev
        ? {
            ...prev,
            snippets: prev.snippets
              .filter((s) => s.id !== id)
              .map((s) => rehomedById.get(s.id) ?? s),
          }
        : prev
    );

    await saveQueueRef.current.now(`snip:${id}`, () => removeSnippet(id));
    for (const child of rehomedChildren) {
      await saveQueueRef.current.now(`snip:${child.id}`, () =>
        saveSnippet(child, cryptoKeyRef.current)
      );
    }
    showToast('Snippet removed from local database');
  };

  const handleSaveSnippetFromCode = async (
    code: string,
    language: SupportedLanguage,
    parentSnippetId?: string,
    actionKind?: SnippetActionKind
  ) => {
    const current = workspaceRef.current;
    const parent = parentSnippetId
      ? current?.snippets.find((s) => s.id === parentSnippetId)
      : undefined;

    if (parent) {
      const [child] = createChildSnippets({
        parent,
        blocks: [{ code, language, rawLanguage: language }],
        actionKind: actionKind || 'chat',
        prompt: 'Saved code block from Gemma AI response',
        model: current?.runtimeConfig.selectedModel,
      });
      setWorkspace((prev) =>
        prev ? { ...prev, snippets: [...prev.snippets, child] } : prev
      );
      await saveQueueRef.current.now(`snip:${child.id}`, () =>
        saveSnippet(child, cryptoKeyRef.current)
      );
      showToast(`Saved child snippet under "${parent.title}"`);
      return;
    }

    const now = Date.now();
    const targetProject =
      activeProjectId !== 'all'
        ? activeProjectId
        : workspace?.projects[0]?.id || 'proj-core';
    const firstLine =
      code
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim()
        .slice(0, 40) || 'Saved Snippet';

    const snippet: CodeSnippet = {
      id: `snip-${crypto.randomUUID()}`,
      projectId: targetProject,
      version: 1,
      title: `${language.toUpperCase()} · ${firstLine}`,
      language,
      code,
      notes: 'Saved directly from GemmaVault workspace.',
      tags: ['gemma'],
      favorite: false,
      createdAt: now,
      updatedAt: now,
    };
    setWorkspace((prev) =>
      prev ? { ...prev, snippets: [snippet, ...prev.snippets] } : prev
    );
    await saveQueueRef.current.now(`snip:${snippet.id}`, () =>
      saveSnippet(snippet, cryptoKeyRef.current)
    );
    showToast('Saved code block to Snippets');
  };

  const handleSaveGeneratedSnippets = useCallback(
    async (input: {
      parentSnippetId: string;
      actionKind: SnippetActionKind;
      prompt: string;
      model?: string;
      assistantMarkdown: string;
    }): Promise<SavedSnippetRef[]> => {
      const current = workspaceRef.current;
      if (!current) return [];
      const parent = current.snippets.find((s) => s.id === input.parentSnippetId);
      if (!parent) return [];

      const blocks = extractFencedCodeBlocks(input.assistantMarkdown);
      if (blocks.length === 0) return [];

      const created = createChildSnippets({
        parent,
        blocks,
        actionKind: input.actionKind,
        prompt: input.prompt,
        model: input.model,
      });

      setWorkspace((prev) =>
        prev ? { ...prev, snippets: [...prev.snippets, ...created] } : prev
      );

      await Promise.all(
        created.map((child) =>
          saveQueueRef.current.now(`snip:${child.id}`, () =>
            saveSnippet(child, cryptoKeyRef.current)
          )
        )
      );

      showToastRef.current(
        created.length === 1
          ? `Saved child snippet under "${parent.title}"`
          : `Saved ${created.length} child snippets under "${parent.title}"`
      );

      return created.map((child) => ({
        id: child.id,
        title: child.title,
        parentId: parent.id,
        parentTitle: parent.title,
      }));
    },
    []
  );

  /**
   * Overwrites a snippet with edited code, but only if it is still exactly what the edit preview was
   * computed from; otherwise the user would silently lose changes made in the meantime.
   */
  const handleApplyEditToSnippet = useCallback(
    async (
      snippetId: string,
      newCode: string,
      expectedHash: string
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const current = workspaceRef.current?.snippets.find((s) => s.id === snippetId);
      if (!current) return { ok: false, reason: 'That snippet no longer exists.' };
      if (hashText(current.code) !== expectedHash) {
        return {
          ok: false,
          reason: 'The snippet changed after this preview was generated, so nothing was applied. Review the edit again.',
        };
      }
      const updated: CodeSnippet = { ...current, code: newCode, updatedAt: Date.now() };
      setWorkspace((prev) =>
        prev ? { ...prev, snippets: prev.snippets.map((s) => (s.id === snippetId ? updated : s)) } : prev
      );
      // Keep the ref in step immediately so a quick Undo/Apply sees the new code.
      if (workspaceRef.current) {
        workspaceRef.current = {
          ...workspaceRef.current,
          snippets: workspaceRef.current.snippets.map((s) => (s.id === snippetId ? updated : s)),
        };
      }
      await saveQueueRef.current.now(`snip:${snippetId}`, () => saveSnippet(updated, cryptoKeyRef.current));
      showToastRef.current(`Updated "${current.title}"`);
      return { ok: true };
    },
    []
  );

  const handleSaveEditAsVersion = useCallback(
    async (input: {
      parentSnippetId: string;
      newCode: string;
      prompt: string;
      model?: string;
    }): Promise<SavedSnippetRef | null> => {
      const parent = workspaceRef.current?.snippets.find((s) => s.id === input.parentSnippetId);
      if (!parent) return null;
      const [derived] = createChildSnippets({
        parent,
        blocks: [{ code: input.newCode, language: parent.language, rawLanguage: '' }],
        actionKind: 'edit',
        prompt: input.prompt,
        model: input.model,
      });
      const child: CodeSnippet = { ...derived, baseHash: hashText(parent.code) };
      setWorkspace((prev) => (prev ? { ...prev, snippets: [...prev.snippets, child] } : prev));
      await saveQueueRef.current.now(`snip:${child.id}`, () => saveSnippet(child, cryptoKeyRef.current));
      showToastRef.current(`Saved new version under "${parent.title}"`);
      return { id: child.id, title: child.title, parentId: parent.id, parentTitle: parent.title };
    },
    []
  );

  const handleSaveDoc = (doc: DocPage) => {
    setWorkspace((prev) => {
      if (!prev) return prev;
      const exists = prev.docs.some((d) => d.id === doc.id);
      const nextDocs = exists
        ? prev.docs.map((d) => (d.id === doc.id ? doc : d))
        : [doc, ...prev.docs];
      return { ...prev, docs: nextDocs };
    });
    saveQueueRef.current.schedule(`doc:${doc.id}`, () =>
      saveDoc(doc, cryptoKeyRef.current)
    );
  };

  const handleDeleteDoc = async (id: string) => {
    setWorkspace((prev) =>
      prev ? { ...prev, docs: prev.docs.filter((d) => d.id !== id) } : prev
    );
    await saveQueueRef.current.now(`doc:${id}`, () => removeDoc(id));
    showToast('Documentation page removed');
  };

  const handleCreateSession = async () => {
    const now = Date.now();
    const fallbackProject = workspace?.projects[0]?.id || 'proj-core';
    const newSession: ChatSession = {
      id: `chat-${crypto.randomUUID()}`,
      projectId: activeProjectId === 'all' ? fallbackProject : activeProjectId,
      title: 'New Coding Session',
      messages: [
        {
          id: `msg-${crypto.randomUUID()}`,
          role: 'assistant',
          model: workspace?.runtimeConfig.selectedModel || 'Gemma Local',
          createdAt: now,
          content:
            'New local coding session started. Attach any snippet or doc, or ask a question below.',
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    setWorkspace((prev) =>
      prev ? { ...prev, sessions: [newSession, ...prev.sessions] } : prev
    );
    setActiveSessionId(newSession.id);
    setActiveTab('assistant');
    await saveQueueRef.current.now(`chat:${newSession.id}`, () =>
      saveChatSession(newSession, cryptoKeyRef.current)
    );
  };

  const handleUpdateSession = async (
    session: ChatSession,
    options?: { immediate?: boolean }
  ) => {
    // A stream that finishes after the vault locked must not resurrect decrypted state.
    if (!workspaceRef.current) return;
    setWorkspace((prev) => {
      if (!prev) return prev;
      const exists = prev.sessions.some((s) => s.id === session.id);
      const next = exists
        ? prev.sessions.map((s) => (s.id === session.id ? session : s))
        : [session, ...prev.sessions];
      return { ...prev, sessions: next };
    });

    if (options?.immediate) {
      await saveQueueRef.current.now(`chat:${session.id}`, () =>
        saveChatSession(session, cryptoKeyRef.current)
      );
    } else {
      saveQueueRef.current.schedule(`chat:${session.id}`, () =>
        saveChatSession(session, cryptoKeyRef.current)
      );
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (activeSessionId === id) {
      const next = workspaceRef.current?.sessions.find((x) => x.id !== id);
      setActiveSessionId(next?.id || '');
    }
    setWorkspace((prev) =>
      prev ? { ...prev, sessions: prev.sessions.filter((s) => s.id !== id) } : prev
    );
    await saveQueueRef.current.now(`chat:${id}`, () => removeChatSession(id));
  };

  const handleSendToGemma = (
    snippet: CodeSnippet,
    actionPrompt: string,
    actionKind?: SnippetActionKind
  ) => {
    setQueuedPrompt({
      prompt: actionPrompt,
      attachments: [{ kind: 'snippet', id: snippet.id, title: snippet.title }],
      actionKind,
    });
    setActiveTab('assistant');
  };

  const handleOpenSnippet = (snippetId: string) => {
    const target = workspaceRef.current?.snippets.find((s) => s.id === snippetId);
    if (!target) {
      showToast('This snippet is no longer in the vault.');
      return;
    }
    if (activeProjectId !== 'all' && target.projectId !== activeProjectId) {
      setActiveProjectId('all');
    }
    setSelectedSnippetId(snippetId);
    setActiveTab('snippets');
    setSnippetOpenNonce((n) => n + 1);
  };

  const handleSendDocToGemma = (doc: DocPage, actionPrompt: string) => {
    setQueuedPrompt({
      prompt: actionPrompt,
      attachments: [{ kind: 'doc', id: doc.id, title: doc.title }],
    });
    setActiveTab('assistant');
  };

  const [mobileDetailActive, setMobileDetailActive] = useState(false);

  // Clear mobile detail flag when switching away from snippets/docs.
  useEffect(() => {
    if (activeTab !== 'snippets' && activeTab !== 'docs') {
      setMobileDetailActive(false);
    }
  }, [activeTab]);

  const handleSaveRuntimeConfig = async (next: LocalRuntimeConfig) => {
    await saveQueueRef.current.now('settings:runtime', () =>
      saveRuntimeConfig(next, cryptoKeyRef.current)
    );
    setWorkspace((prev) => (prev ? { ...prev, runtimeConfig: next } : prev));
  };

  const handleEnableEncryption = async (passphrase: string, autoLockMinutes: number) => {
    if (!workspace) return;
    await saveQueueRef.current.flushAll();
    const { key, meta } = await enableVaultEncryption(passphrase, workspace, autoLockMinutes);
    channelRef.current?.postMessage('security-changed');
    setCryptoKey(key);
    setWorkspace((prev) => (prev ? { ...prev, securityMeta: meta } : prev));
    lastActivityRef.current = Date.now();
  };

  const handleChangePassphrase = async (currentPass: string, newPass: string) => {
    if (!workspace) return;
    await saveQueueRef.current.flushAll();
    const { key, meta } = await changeVaultPassphrase(currentPass, newPass, workspace);
    channelRef.current?.postMessage('security-changed');
    setCryptoKey(key);
    setWorkspace((prev) => (prev ? { ...prev, securityMeta: meta } : prev));
    lastActivityRef.current = Date.now();
  };

  const handleDisableEncryption = async () => {
    if (!workspace) return;
    await saveQueueRef.current.flushAll();
    const meta = await disableVaultEncryption(workspace);
    channelRef.current?.postMessage('security-changed');
    setCryptoKey(null);
    setWorkspace((prev) => (prev ? { ...prev, securityMeta: meta } : prev));
  };

  const handleUpdateAutoLock = async (minutes: number) => {
    if (!workspace) return;
    const nextMeta = { ...workspace.securityMeta, autoLockMinutes: minutes, updatedAt: Date.now() };
    await updateSecurityMeta(nextMeta);
    setWorkspace((prev) => (prev ? { ...prev, securityMeta: nextMeta } : prev));
  };

  const handleExportBackup = async () => {
    if (!workspace) {
      throw new Error('Workspace is not loaded.');
    }
    await saveQueueRef.current.flushAll();
    return exportVaultBackup(workspace, cryptoKeyRef.current);
  };

  const handleImportBackup = async (bundle: VaultBackupBundle, passphrase: string | null) => {
    await saveQueueRef.current.flushAll();
    const restored = await importVaultBackup(bundle, passphrase, cryptoKeyRef.current);
    channelRef.current?.postMessage('security-changed');
    setWorkspace(restored);
    setActiveSessionId(restored.sessions[0]?.id || '');
    setSelectedSnippetId(restored.snippets[0]?.id || null);
    setActiveProjectId('all');
  };

  const handleCreateProject = async (
    name: string,
    description: string,
    defaultLanguage: SupportedLanguage
  ) => {
    const now = Date.now();
    const project: Project = {
      id: `proj-${crypto.randomUUID()}`,
      name,
      description,
      defaultLanguage,
      createdAt: now,
      updatedAt: now,
    };
    await saveQueueRef.current.now(`proj:${project.id}`, () =>
      saveProject(project, cryptoKeyRef.current)
    );
    setWorkspace((prev) =>
      prev ? { ...prev, projects: [...prev.projects, project] } : prev
    );
    showToast(`Project "${name}" created`);
  };

  const handleDeleteProject = async (id: string) => {
    if (!workspace) return;
    const remainingProjects = workspace.projects.filter((p) => p.id !== id);
    if (remainingProjects.length === 0) {
      showToast('At least one workspace project is required.');
      return;
    }
    const fallbackProject = remainingProjects[0];

    await saveQueueRef.current.flushAll();
    const rehomed = await removeProjectAndRehome({
      projectId: id,
      fallbackProjectId: fallbackProject.id,
      snippets: workspace.snippets,
      docs: workspace.docs,
      sessions: workspace.sessions,
      key: cryptoKeyRef.current,
    });

    setWorkspace((prev) =>
      prev
        ? {
            ...prev,
            projects: prev.projects.filter((p) => p.id !== id),
            snippets: rehomed.snippets,
            docs: rehomed.docs,
            sessions: rehomed.sessions,
          }
        : prev
    );
    if (activeProjectId === id) setActiveProjectId('all');
    showToast(`Project removed; items moved to "${fallbackProject.name}"`);
  };

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-600 dark:bg-[#0B1120] dark:text-slate-400">
        Initializing local database...
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4 dark:bg-[#0B1120]">
        <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 text-sm text-slate-700 dark:border-rose-900/60 dark:bg-slate-900 dark:text-slate-300">
          <h1 className="text-base font-semibold text-slate-900 dark:text-white">
            Local database unavailable
          </h1>
          <p className="mt-2 leading-relaxed">
            GemmaVault stores everything in this browser's IndexedDB and cannot start without it.
            Private/incognito windows, blocked site data, or a full disk are the usual causes.
          </p>
          <p className="mt-2 break-words font-mono text-xs text-rose-700 dark:text-rose-400">
            {bootError}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 min-h-[40px] rounded-lg bg-teal-600 px-4 text-xs font-medium text-white hover:bg-teal-500"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (locked) {
    return <VaultLockScreen onUnlock={handleUnlock} />;
  }

  if (!workspace) {
    return null;
  }

  const navItems: Array<{
    id: WorkspaceTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'assistant', label: 'Gemma AI', icon: Cpu },
    { id: 'snippets', label: 'Snippets', icon: Code2 },
    { id: 'docs', label: 'Docs', icon: BookOpen },
    { id: 'database', label: 'Vault DB', icon: Database },
  ];

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-[#0B1120] dark:text-slate-100">
      {/* Compact 3-Zone Top Navigation Bar (48px mobile, 56px desktop) */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:h-14 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          onClick={() => setActiveTab('assistant')}
          className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 sm:text-lg dark:text-white"
        >
          GemmaVault
        </button>

        <nav aria-label="Primary sections" className="hidden items-center gap-6 md:flex">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`relative py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'text-teal-700 dark:text-teal-400'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                }`}
              >
                {item.label}
                {active && (
                  <span className="absolute right-0 bottom-0 left-0 h-0.5 rounded-full bg-teal-600 dark:bg-teal-400" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          {!isOnline && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
              <WifiOff className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Offline</span>
            </span>
          )}

          <PWAInstallButton />

          <button
            type="button"
            onClick={() => setDarkMode((v) => !v)}
            aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
            className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          {workspace.securityMeta.encryptionEnabled ? (
            <button
              type="button"
              onClick={handleLockNow}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0 dark:bg-teal-600 dark:hover:bg-teal-500"
            >
              <Lock className="h-3.5 w-3.5" />
              Lock Vault
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setActiveTab('snippets');
                const now = Date.now();
                const targetProj =
                  activeProjectId !== 'all'
                    ? activeProjectId
                    : workspace.projects[0]?.id || 'proj-core';
                const newId = `snip-${crypto.randomUUID()}`;
                handleSaveSnippet({
                  id: newId,
                  projectId: targetProj,
                  version: 1,
                  title: 'New Code Snippet',
                  language: 'typescript',
                  code: '// Start coding offline\n',
                  notes: '',
                  tags: [],
                  favorite: false,
                  createdAt: now,
                  updatedAt: now,
                });
                setSelectedSnippetId(newId);
                setSnippetOpenNonce((n) => n + 1);
              }}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-500 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              New Snippet
            </button>
          )}
        </div>
      </header>

      <RuntimeStatusBar
        status={runtimeStatus.status}
        refreshing={runtimeStatus.refreshing}
        lastCheckedAt={runtimeStatus.lastCheckedAt}
        onRecheck={() => void runtimeStatus.recheck()}
        onOpenSettings={() => setRuntimeModalOpen(true)}
      />

      {/* Main Responsive Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden pb-14 md:pb-0">
        {/* Desktop Project & Quick-Jump Rail */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white xl:flex dark:border-slate-800 dark:bg-slate-900/50">
          <div className="border-b border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
              <FolderKanban className="h-3.5 w-3.5" />
              Projects
            </div>
            <div className="mt-2.5 space-y-1">
              <button
                type="button"
                onClick={() => setActiveProjectId('all')}
                className={`flex min-h-[36px] w-full items-center justify-between rounded-lg px-2.5 text-xs font-medium transition-colors ${
                  activeProjectId === 'all'
                    ? 'bg-teal-500/10 text-teal-700 dark:text-teal-300'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <span>All Workspaces</span>
                <span className="font-mono tabular-nums text-slate-400">
                  {workspace.snippets.length + workspace.docs.length}
                </span>
              </button>
              {workspace.projects.map((proj) => {
                const count =
                  workspace.snippets.filter((s) => s.projectId === proj.id).length +
                  workspace.docs.filter((d) => d.projectId === proj.id).length;
                return (
                  <button
                    key={proj.id}
                    type="button"
                    onClick={() => setActiveProjectId(proj.id)}
                    className={`flex min-h-[36px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                      activeProjectId === proj.id
                        ? 'bg-teal-500/10 text-teal-700 dark:text-teal-300'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="truncate">{proj.name}</span>
                    <span className="font-mono tabular-nums text-slate-400">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Installed Local Gemma
              </div>
              <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                <div className="truncate font-mono text-xs font-medium text-slate-900 dark:text-slate-100">
                  {workspace.runtimeConfig.selectedModel}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {probe.connected
                    ? `${probe.models.length} local model${probe.models.length === 1 ? '' : 's'} ready`
                    : 'Waiting for local daemon'}
                </div>
                <button
                  type="button"
                  onClick={() => setRuntimeModalOpen(true)}
                  className="mt-2.5 min-h-[36px] w-full rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Runtime Settings
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Database Security
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {workspace.securityMeta.encryptionEnabled
                  ? 'Encrypted at rest with AES-256-GCM.'
                  : 'Stored locally in IndexedDB. Enable passphrase lock in Vault DB.'}
              </p>
            </div>
          </div>
        </aside>

        {/* Active View Viewport */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Tablet & Mobile Project Filter Strip (hidden on mobile while an individual snippet/doc editor is open) */}
          {(activeTab === 'snippets' || activeTab === 'docs') && (
            <div
              className={`${
                mobileDetailActive ? 'hidden lg:flex' : 'flex'
              } items-center justify-between gap-2 border-b border-slate-200 bg-white/80 px-4 py-2 xl:hidden dark:border-slate-800 dark:bg-slate-900/50`}
            >
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <FolderKanban className="h-3.5 w-3.5 shrink-0" />
                <span>Workspace</span>
              </div>
              <select
                aria-label="Filter by workspace project"
                value={activeProjectId}
                onChange={(e) => setActiveProjectId(e.target.value)}
                className="min-h-[40px] lg:min-h-[36px] pointer-coarse:min-h-[40px] max-w-[220px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
              >
                <option value="all">All Workspaces</option>
                {workspace.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'assistant' && (
              <GemmaAssistantPane
                sessions={workspace.sessions}
                activeSessionId={activeSessionId}
                onSelectSession={setActiveSessionId}
                onCreateSession={handleCreateSession}
                onUpdateSession={handleUpdateSession}
                onDeleteSession={handleDeleteSession}
                snippets={workspace.snippets}
                docs={workspace.docs}
                runtimeConfig={workspace.runtimeConfig}
                probe={probe}
                probing={probing}
                onRescanRuntime={() => runRuntimeProbe()}
                onOpenRuntimeModal={() => setRuntimeModalOpen(true)}
                onSaveSnippetFromCode={handleSaveSnippetFromCode}
                onSaveGeneratedSnippets={handleSaveGeneratedSnippets}
                onApplyEditToSnippet={handleApplyEditToSnippet}
                onSaveEditAsVersion={handleSaveEditAsVersion}
                onOpenSnippet={handleOpenSnippet}
                queuedPrompt={queuedPrompt}
                onClearQueuedPrompt={() => setQueuedPrompt(null)}
              />
            )}

            {activeTab === 'snippets' && (
              <SnippetsView
                snippets={workspace.snippets}
                projects={workspace.projects}
                activeProjectId={activeProjectId}
                selectedSnippetId={selectedSnippetId}
                onSelectSnippet={setSelectedSnippetId}
                mobileOpenNonce={snippetOpenNonce}
                onSaveSnippet={handleSaveSnippet}
                onDeleteSnippet={handleDeleteSnippet}
                onSendToGemma={handleSendToGemma}
                onMobileDetailChange={setMobileDetailActive}
              />
            )}

            {activeTab === 'docs' && (
              <DocsView
                docs={workspace.docs}
                projects={workspace.projects}
                activeProjectId={activeProjectId}
                onSaveDoc={handleSaveDoc}
                onDeleteDoc={handleDeleteDoc}
                onSaveSnippetFromCode={handleSaveSnippetFromCode}
                onSendDocToGemma={handleSendDocToGemma}
                onMobileDetailChange={setMobileDetailActive}
              />
            )}

            {activeTab === 'database' && (
              <VaultDatabaseView
                projects={workspace.projects}
                snippets={workspace.snippets}
                docs={workspace.docs}
                sessions={workspace.sessions}
                securityMeta={workspace.securityMeta}
                onEnableEncryption={handleEnableEncryption}
                onDisableEncryption={handleDisableEncryption}
                onChangePassphrase={handleChangePassphrase}
                onLockNow={handleLockNow}
                onUpdateAutoLock={handleUpdateAutoLock}
                onExportBackup={handleExportBackup}
                onImportBackup={handleImportBackup}
                onCreateProject={handleCreateProject}
                onDeleteProject={handleDeleteProject}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mobile Bottom Tab Bar (56px height) */}
      <nav
        aria-label="Mobile navigation"
        className="fixed right-0 bottom-0 left-0 z-40 grid h-14 grid-cols-4 border-t border-slate-200 bg-white/95 backdrop-blur-md pb-safe md:hidden dark:border-slate-800 dark:bg-slate-900/95"
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex min-h-[44px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'text-teal-700 dark:text-teal-400'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Local Gemma Model Configuration Modal */}
      <LocalGemmaSetupModal
        isOpen={runtimeModalOpen}
        onClose={() => setRuntimeModalOpen(false)}
        config={workspace.runtimeConfig}
        probe={probe}
        webgpu={webgpu}
        probing={probing}
        onSaveConfig={handleSaveRuntimeConfig}
        onRescan={runRuntimeProbe}
      />

      {toast && (
        <div
          role="status"
          className="fixed right-4 bottom-16 z-50 rounded-xl border border-slate-200 bg-slate-900 px-4 py-2.5 text-xs font-medium text-white shadow-lg md:bottom-5 dark:border-slate-700 dark:bg-slate-800"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ConfirmProvider>
      <AppShell />
    </ConfirmProvider>
  );
}

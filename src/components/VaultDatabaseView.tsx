import React, { useEffect, useState } from 'react';
import {
  Database,
  Download,
  FolderPlus,
  HardDrive,
  KeyRound,
  Lock,
  ShieldCheck,
  Trash2,
  Unlock,
  Upload,
} from 'lucide-react';
import {
  evaluatePassphraseStrength,
  isWebCryptoAvailable,
  MIN_PASSPHRASE_LENGTH,
} from '../lib/crypto';
import {
  estimateStorageUsage,
  parseBackupFile,
  requestPersistentStorage,
} from '../lib/db';
import { SUPPORTED_LANGUAGES } from '../lib/syntax';
import type {
  ChatSession,
  CodeSnippet,
  DocPage,
  Project,
  SupportedLanguage,
  VaultBackupBundle,
  VaultSecurityMeta,
} from '../types/vault';
import { useConfirm } from './ConfirmDialog';

interface VaultDatabaseViewProps {
  projects: Project[];
  snippets: CodeSnippet[];
  docs: DocPage[];
  sessions: ChatSession[];
  securityMeta: VaultSecurityMeta;
  onEnableEncryption: (passphrase: string, autoLockMinutes: number) => Promise<void>;
  onDisableEncryption: () => Promise<void>;
  onChangePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
  onLockNow: () => void;
  onUpdateAutoLock: (minutes: number) => Promise<void>;
  onExportBackup: () => Promise<VaultBackupBundle>;
  onImportBackup: (bundle: VaultBackupBundle, passphrase: string | null) => Promise<void>;
  onCreateProject: (
    name: string,
    description: string,
    defaultLanguage: SupportedLanguage
  ) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const VaultDatabaseView: React.FC<VaultDatabaseViewProps> = ({
  projects,
  snippets,
  docs,
  sessions,
  securityMeta,
  onEnableEncryption,
  onDisableEncryption,
  onChangePassphrase,
  onLockNow,
  onUpdateAutoLock,
  onExportBackup,
  onImportBackup,
  onCreateProject,
  onDeleteProject,
}) => {
  const confirm = useConfirm();
  const [storageStats, setStorageStats] = useState<{
    usageBytes: number;
    quotaBytes: number;
    persisted: boolean;
  } | null>(null);
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [curPass, setCurPass] = useState('');
  const [chgPass, setChgPass] = useState('');
  const [chgConfirm, setChgConfirm] = useState('');
  const [autoLockMins, setAutoLockMins] = useState(securityMeta.autoLockMinutes);
  const [securityMsg, setSecurityMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [projName, setProjName] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [projLang, setProjLang] = useState<SupportedLanguage>('typescript');

  const [pendingImportBundle, setPendingImportBundle] = useState<VaultBackupBundle | null>(null);
  const [importPass, setImportPass] = useState('');

  useEffect(() => {
    estimateStorageUsage().then(setStorageStats);
  }, [snippets.length, docs.length, projects.length, sessions.length]);

  useEffect(() => {
    setAutoLockMins(securityMeta.autoLockMinutes);
  }, [securityMeta.autoLockMinutes]);

  const newPassStrength = newPass ? evaluatePassphraseStrength(newPass) : null;
  const chgPassStrength = chgPass ? evaluatePassphraseStrength(chgPass) : null;

  const handleRequestPersist = async () => {
    const granted = await requestPersistentStorage();
    const updated = await estimateStorageUsage();
    if (updated) setStorageStats(updated);
    setSecurityMsg({
      kind: granted ? 'ok' : 'err',
      text: granted
        ? 'Browser granted persistent storage — offline IndexedDB data is protected from automatic eviction.'
        : 'Browser denied persistent storage or requires installing the PWA first.',
    });
  };

  const handleEnableEncryption = async (e: React.FormEvent) => {
    e.preventDefault();
    setSecurityMsg(null);
    if (newPass.length < MIN_PASSPHRASE_LENGTH) {
      setSecurityMsg({
        kind: 'err',
        text: `Use at least ${MIN_PASSPHRASE_LENGTH} characters for your master passphrase.`,
      });
      return;
    }
    if (newPass !== confirmPass) {
      setSecurityMsg({ kind: 'err', text: 'Passphrase confirmation does not match.' });
      return;
    }

    const accepted = await confirm({
      title: 'Enable AES-256-GCM Encryption',
      message:
        'There is no passphrase recovery if you lose this master passphrase. Export a backup after sealing your vault. Continue?',
      confirmLabel: 'Encrypt Vault',
      destructive: false,
    });
    if (!accepted) return;

    setBusy(true);
    try {
      await onEnableEncryption(newPass, autoLockMins);
      setNewPass('');
      setConfirmPass('');
      setSecurityMsg({
        kind: 'ok',
        text: 'All local snippets, documentation, and chats are now encrypted with AES-256-GCM.',
      });
    } catch (err) {
      setSecurityMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to encrypt local database.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleChangePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setSecurityMsg(null);
    if (!curPass) {
      setSecurityMsg({ kind: 'err', text: 'Enter your current master passphrase.' });
      return;
    }
    if (chgPass.length < MIN_PASSPHRASE_LENGTH) {
      setSecurityMsg({
        kind: 'err',
        text: `New passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      });
      return;
    }
    if (chgPass !== chgConfirm) {
      setSecurityMsg({ kind: 'err', text: 'New passphrase confirmation does not match.' });
      return;
    }
    setBusy(true);
    try {
      await onChangePassphrase(curPass, chgPass);
      setCurPass('');
      setChgPass('');
      setChgConfirm('');
      setSecurityMsg({
        kind: 'ok',
        text: 'Master passphrase rotated and all IndexedDB records re-encrypted.',
      });
    } catch (err) {
      setSecurityMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Unable to rotate passphrase.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDisableEncryption = async () => {
    const accepted = await confirm({
      title: 'Disable Vault Encryption',
      message:
        'All snippets, documentation, and local chat threads will be stored unencrypted in IndexedDB on this browser. Continue?',
      confirmLabel: 'Decrypt Vault',
      destructive: true,
    });
    if (!accepted) return;

    setBusy(true);
    setSecurityMsg(null);
    try {
      await onDisableEncryption();
      setSecurityMsg({
        kind: 'ok',
        text: 'Passphrase lock removed. Records remain offline in IndexedDB.',
      });
    } catch (err) {
      setSecurityMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Unable to disable encryption.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    const bundle = await onExportBackup();
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateSlug = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `gemmavault-backup-${dateSlug}.gvbackup`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSecurityMsg(null);
    try {
      if (file.size > 50 * 1024 * 1024) {
        throw new Error('Backup file exceeds maximum supported size (50 MB).');
      }
      const text = await file.text();
      const parsed = parseBackupFile(text);
      if (parsed.encrypted) {
        setPendingImportBundle(parsed);
        setImportPass('');
      } else {
        const accepted = await confirm({
          title: 'Replace Local Database',
          message:
            'Importing this backup will overwrite your current projects, snippets, docs, and chat sessions. Export a backup first if needed.',
          confirmLabel: 'Import Backup',
          destructive: true,
        });
        if (!accepted) return;
        await onImportBackup(parsed, null);
        setSecurityMsg({ kind: 'ok', text: 'Backup imported into local IndexedDB.' });
      }
    } catch (err) {
      setSecurityMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Invalid backup file.',
      });
    } finally {
      e.target.value = '';
    }
  };

  const handleConfirmEncryptedImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingImportBundle) return;
    const accepted = await confirm({
      title: 'Overwrite Local Database',
      message:
        'Decrypting and restoring this backup will replace all existing local projects, snippets, docs, and sessions.',
      confirmLabel: 'Decrypt & Restore',
      destructive: true,
    });
    if (!accepted) return;

    setBusy(true);
    setSecurityMsg(null);
    try {
      await onImportBackup(pendingImportBundle, importPass);
      setPendingImportBundle(null);
      setImportPass('');
      setSecurityMsg({ kind: 'ok', text: 'Encrypted backup decrypted and restored.' });
    } catch (err) {
      setSecurityMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Decryption failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateProj = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projName.trim()) return;
    await onCreateProject(projName.trim(), projDesc.trim(), projLang);
    setProjName('');
    setProjDesc('');
  };

  const handleDeleteProj = async (proj: Project) => {
    const sCount = snippets.filter((s) => s.projectId === proj.id).length;
    const dCount = docs.filter((d) => d.projectId === proj.id).length;
    const cCount = sessions.filter((c) => c.projectId === proj.id).length;
    const fallbackName = projects.find((p) => p.id !== proj.id)?.name || 'another project';
    const accepted = await confirm({
      title: `Remove "${proj.name}"`,
      message: `Its snippets (${sCount}), docs (${dCount}), and chat sessions (${cCount}) will be kept and moved to "${fallbackName}". Continue?`,
      confirmLabel: 'Remove Project',
      destructive: true,
    });
    if (!accepted) return;
    await onDeleteProject(proj.id);
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-50 p-4 sm:p-6 lg:p-8 dark:bg-[#0B1120]">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">
              Local Encrypted Database
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Offline IndexedDB persistence with WebCrypto AES-256-GCM sealing and portable backups.
            </p>
          </div>
          {securityMeta.encryptionEnabled && (
            <button
              type="button"
              onClick={onLockNow}
              className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700"
            >
              <Lock className="h-4 w-4" />
              Lock Vault Now
            </button>
          )}
        </div>

        {/* Summary Metric Strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="text-xs text-slate-500 dark:text-slate-400">Code Snippets</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
              {snippets.length}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="text-xs text-slate-500 dark:text-slate-400">Documentation Pages</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
              {docs.length}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="text-xs text-slate-500 dark:text-slate-400">Projects · Chats</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
              {projects.length} · {sessions.length}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="text-xs text-slate-500 dark:text-slate-400">Local Storage Used</div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
              {storageStats ? formatBytes(storageStats.usageBytes) : 'Local'}
            </div>
          </div>
        </div>

        {securityMsg && (
          <div
            role="status"
            className={`rounded-xl border px-4 py-3 text-sm ${
              securityMsg.kind === 'ok'
                ? 'border-teal-500/30 bg-teal-500/10 text-teal-800 dark:text-teal-300'
                : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
            }`}
          >
            {securityMsg.text}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Encryption Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                {securityMeta.encryptionEnabled ? (
                  <ShieldCheck className="h-5 w-5 text-teal-600 dark:text-teal-400" />
                ) : (
                  <KeyRound className="h-5 w-5 text-slate-500 dark:text-slate-400" />
                )}
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                  Vault Encryption
                </h2>
              </div>
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {securityMeta.encryptionEnabled ? 'AES-256-GCM Active' : 'Unencrypted Local Mode'}
              </span>
            </div>

            {!isWebCryptoAvailable() ? (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                WebCrypto requires a secure localhost or HTTPS context to seal IndexedDB records.
              </p>
            ) : securityMeta.encryptionEnabled ? (
              <div className="mt-4 space-y-5">
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  Every snippet, Markdown doc, and chat message is encrypted with a 256-bit key derived via PBKDF2-SHA256 ({securityMeta.iterations.toLocaleString()} iterations) and AAD-bound before persistence.
                </p>

                <div>
                  <label
                    htmlFor="autolock-select"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Auto-Lock Inactivity Timeout
                  </label>
                  <select
                    id="autolock-select"
                    value={autoLockMins}
                    onChange={(e) => {
                      const mins = Number(e.target.value);
                      setAutoLockMins(mins);
                      onUpdateAutoLock(mins);
                    }}
                    className="mt-1.5 min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={0}>Never auto-lock</option>
                  </select>
                </div>

                {/* Change Master Passphrase */}
                <form
                  onSubmit={handleChangePassphrase}
                  className="space-y-2.5 border-t border-slate-200 pt-4 dark:border-slate-800"
                >
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Rotate Master Passphrase
                  </div>
                  <input
                    type="password"
                    value={curPass}
                    onChange={(e) => setCurPass(e.target.value)}
                    placeholder="Current passphrase"
                    className="min-h-[40px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                  />
                  <input
                    type="password"
                    value={chgPass}
                    onChange={(e) => setChgPass(e.target.value)}
                    placeholder={`New passphrase (min ${MIN_PASSPHRASE_LENGTH} chars)`}
                    className="min-h-[40px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                  />
                  {chgPassStrength && (
                    <p
                      className={`text-[11px] ${
                        chgPassStrength.valid
                          ? 'text-teal-700 dark:text-teal-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {chgPassStrength.label}
                    </p>
                  )}
                  <input
                    type="password"
                    value={chgConfirm}
                    onChange={(e) => setChgConfirm(e.target.value)}
                    placeholder="Confirm new passphrase"
                    className="min-h-[40px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                  />
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-teal-600 px-3.5 text-xs font-medium text-white hover:bg-teal-500 disabled:opacity-50"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Change Passphrase
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleDisableEncryption}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-300 px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      <Unlock className="h-3.5 w-3.5" />
                      Disable Lock
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <form onSubmit={handleEnableEncryption} className="mt-4 space-y-3">
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  Set a master passphrase to encrypt all local database entries at rest with AES-256-GCM. Your passphrase never leaves your device.
                </p>
                <input
                  type="password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  placeholder={`Create master passphrase (min ${MIN_PASSPHRASE_LENGTH} chars)`}
                  className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                />
                {newPassStrength && (
                  <p
                    className={`text-[11px] ${
                      newPassStrength.valid
                        ? 'text-teal-700 dark:text-teal-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {newPassStrength.label}
                  </p>
                )}
                <input
                  type="password"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  placeholder="Confirm master passphrase"
                  className="min-h-[42px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2 text-xs font-medium text-white hover:bg-teal-500 disabled:opacity-50"
                >
                  <Lock className="h-4 w-4" />
                  {busy ? 'Encrypting Records...' : 'Enable AES-256-GCM Encryption'}
                </button>
              </form>
            )}
          </section>

          {/* Portable Offline Backup & Storage Durability Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="flex items-center gap-2.5">
              <Database className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                Portable Offline Backups
              </h2>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              Export your complete database of snippets, documentation, and chat history as a self-contained <code className="font-mono">.gvbackup</code> archive to transfer between desktop and mobile devices without cloud servers.
            </p>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700"
              >
                <Download className="h-4 w-4" />
                Export Backup
              </button>

              <label className="inline-flex min-h-[44px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800">
                <Upload className="h-4 w-4" />
                Import Backup
                <input
                  type="file"
                  accept=".gvbackup,.json"
                  onChange={handleFilePick}
                  className="hidden"
                />
              </label>
            </div>

            {pendingImportBundle && (
              <form
                onSubmit={handleConfirmEncryptedImport}
                className="mt-4 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-800 dark:bg-slate-950"
              >
                <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                  Enter passphrase for encrypted backup
                </div>
                <input
                  type="password"
                  value={importPass}
                  onChange={(e) => setImportPass(e.target.value)}
                  placeholder="Backup passphrase"
                  className="min-h-[40px] w-full rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="min-h-[38px] rounded-lg bg-teal-600 px-3 text-xs font-medium text-white hover:bg-teal-500"
                  >
                    Decrypt & Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingImportBundle(null)}
                    className="min-h-[38px] rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Offline Storage Durability */}
            <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
                  <HardDrive className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                  <span>
                    Browser Storage Durability:{' '}
                    {storageStats?.persisted ? 'Persistent (Protected)' : 'Best-Effort'}
                  </span>
                </div>
                {!storageStats?.persisted && (
                  <button
                    type="button"
                    onClick={handleRequestPersist}
                    className="min-h-[36px] rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    Request Persistent Storage
                  </button>
                )}
              </div>
              {storageStats && storageStats.quotaBytes > 0 && (
                <p className="mt-1.5 font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  Used {formatBytes(storageStats.usageBytes)} of {formatBytes(storageStats.quotaBytes)} available local quota
                </p>
              )}
            </div>
          </section>
        </div>

        {/* Projects Management */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900/70">
          <div className="flex items-center gap-2.5">
            <FolderPlus className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Workspace Projects
            </h2>
          </div>

          <form onSubmit={handleCreateProj} className="mt-4 grid gap-3 sm:grid-cols-4">
            <input
              type="text"
              value={projName}
              onChange={(e) => setProjName(e.target.value)}
              placeholder="Project name"
              className="min-h-[42px] rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none focus:border-teal-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
            <input
              type="text"
              value={projDesc}
              onChange={(e) => setProjDesc(e.target.value)}
              placeholder="Short description"
              className="min-h-[42px] rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none focus:border-teal-600 sm:col-span-2 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
            />
            <div className="flex gap-2">
              <select
                aria-label="Default language"
                value={projLang}
                onChange={(e) => setProjLang(e.target.value as SupportedLanguage)}
                className="min-h-[42px] flex-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 text-xs text-slate-800 outline-none dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="min-h-[42px] rounded-xl bg-teal-600 px-4 text-xs font-medium text-white hover:bg-teal-500 whitespace-nowrap shrink-0"
              >
                Add
              </button>
            </div>
          </form>

          <div className="mt-4 divide-y divide-slate-200 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {projects.map((p) => {
              const sCount = snippets.filter((s) => s.projectId === p.id).length;
              const dCount = docs.filter((d) => d.projectId === p.id).length;
              return (
                <div key={p.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {p.name}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {p.description || 'No description'} ·{' '}
                      <span className="font-mono">{p.defaultLanguage}</span> ·{' '}
                      <span className="tabular-nums">
                        {sCount} snippets · {dCount} docs
                      </span>
                    </div>
                  </div>
                  {projects.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleDeleteProj(p)}
                      aria-label={`Remove project ${p.name}`}
                      className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

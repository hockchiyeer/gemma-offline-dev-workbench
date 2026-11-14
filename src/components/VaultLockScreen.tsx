import React, { useState } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';

interface VaultLockScreenProps {
  onUnlock: (passphrase: string) => Promise<boolean>;
}

export const VaultLockScreen: React.FC<VaultLockScreenProps> = ({ onUnlock }) => {
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) {
      setError('Enter your master passphrase to decrypt local storage.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const ok = await onUnlock(passphrase);
      if (!ok) {
        setError('Passphrase did not match the encrypted vault verifier.');
      }
    } catch {
      setError('Unable to derive decryption key in this browser context.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12 dark:bg-[#0B1120]">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
              GemmaVault Locked
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              AES-256-GCM · PBKDF2-SHA256 Local Vault
            </p>
          </div>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Your code snippets, project documentation, and local chat history are encrypted at rest inside IndexedDB. Enter your master passphrase to unlock offline access.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="vault-unlock-passphrase"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Master Passphrase
            </label>
            <div className="relative mt-1.5">
              <input
                id="vault-unlock-passphrase"
                type={showPass ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoFocus
                placeholder="Enter passphrase"
                className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-slate-50 pr-11 pl-3.5 text-sm text-slate-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                aria-label={showPass ? 'Hide passphrase' : 'Show passphrase'}
                className="absolute top-1/2 right-1 flex min-h-[40px] min-w-[40px] -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-500 disabled:opacity-60"
          >
            <ShieldCheck className="h-4 w-4" />
            {submitting ? 'Deriving Key...' : 'Unlock Local Vault'}
          </button>
        </form>
      </div>
    </div>
  );
};

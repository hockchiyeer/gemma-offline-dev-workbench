import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowseWorkspaceResult } from '../../src/types/workspace.ts';

const DIALOG_TIMEOUT_MS = 5 * 60_000;

export function resolveInitialBrowseDir(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0')) return undefined;
  try {
    const resolved = fs.realpathSync(path.resolve(trimmed));
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function normalizePickedPath(raw: string, platform: NodeJS.Platform = process.platform): string | null {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  if (platform === 'win32') {
    return trimmed;
  }
  if (trimmed.length > 1) {
    return trimmed.replace(/\/+$/, '') || '/';
  }
  return trimmed;
}

function runDialogFile(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string; enoent: boolean }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: DIALOG_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: env ? { ...process.env, ...env } : process.env,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: stdout || '', stderr: stderr || '', enoent: false });
          return;
        }
        const e = err as { code?: string | number; message?: string };
        const enoent = e.code === 'ENOENT';
        const code = typeof e.code === 'number' ? e.code : 1;
        resolve({ code, stdout: stdout || '', stderr: stderr || e.message || '', enoent });
      }
    );
  });
}

async function pickWindowsFolder(initialDir?: string): Promise<BrowseWorkspaceResult> {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dlg.Description = 'Select a project folder for GemmaVault'",
    '$dlg.ShowNewFolderButton = $false',
    'if ($env:GEMMAVAULT_INITIAL_DIR -and (Test-Path -LiteralPath $env:GEMMAVAULT_INITIAL_DIR -PathType Container)) { $dlg.SelectedPath = $env:GEMMAVAULT_INITIAL_DIR }',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$result = $dlg.ShowDialog($owner)',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) { [Console]::Write($dlg.SelectedPath) }',
    '$owner.Dispose()',
    '$dlg.Dispose()',
  ].join('; ');

  const res = await runDialogFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    initialDir ? { GEMMAVAULT_INITIAL_DIR: initialDir } : undefined
  );

  if (res.enoent || res.code !== 0) {
    return { supported: false, cancelled: false, path: null };
  }
  const picked = normalizePickedPath(res.stdout, 'win32');
  return picked
    ? { supported: true, cancelled: false, path: picked }
    : { supported: true, cancelled: true, path: null };
}

async function pickMacFolder(initialDir?: string): Promise<BrowseWorkspaceResult> {
  const script = initialDir
    ? [
        'set initDir to system attribute "GEMMAVAULT_INITIAL_DIR"',
        'POSIX path of (choose folder with prompt "Select a project folder for GemmaVault" default location (POSIX file initDir))',
      ].join('\n')
    : 'POSIX path of (choose folder with prompt "Select a project folder for GemmaVault")';

  const res = await runDialogFile(
    'osascript',
    ['-e', script],
    initialDir ? { GEMMAVAULT_INITIAL_DIR: initialDir } : undefined
  );

  if (res.enoent) return { supported: false, cancelled: false, path: null };
  if (res.code !== 0) {
    if (/-128|User canceled/i.test(res.stderr)) {
      return { supported: true, cancelled: true, path: null };
    }
    return { supported: false, cancelled: false, path: null };
  }
  const picked = normalizePickedPath(res.stdout, 'darwin');
  return picked
    ? { supported: true, cancelled: false, path: picked }
    : { supported: true, cancelled: true, path: null };
}

async function pickLinuxFolder(initialDir?: string): Promise<BrowseWorkspaceResult> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { supported: false, cancelled: false, path: null };
  }

  const zenityArgs = ['--file-selection', '--directory', '--title=Select a project folder for GemmaVault'];
  if (initialDir) zenityArgs.push(`--filename=${initialDir.replace(/\/+$/, '')}/`);
  const zenity = await runDialogFile('zenity', zenityArgs);
  if (!zenity.enoent) {
    if (zenity.code === 0) {
      const picked = normalizePickedPath(zenity.stdout, 'linux');
      return picked
        ? { supported: true, cancelled: false, path: picked }
        : { supported: true, cancelled: true, path: null };
    }
    if (zenity.code === 1 || zenity.code === 5) {
      return { supported: true, cancelled: true, path: null };
    }
    return { supported: false, cancelled: false, path: null };
  }

  const kdialogArgs = ['--getexistingdirectory', initialDir || process.cwd(), '--title', 'Select a project folder for GemmaVault'];
  const kdialog = await runDialogFile('kdialog', kdialogArgs);
  if (kdialog.enoent) return { supported: false, cancelled: false, path: null };
  if (kdialog.code === 0) {
    const picked = normalizePickedPath(kdialog.stdout, 'linux');
    return picked
      ? { supported: true, cancelled: false, path: picked }
      : { supported: true, cancelled: true, path: null };
  }
  if (kdialog.code === 1) {
    return { supported: true, cancelled: true, path: null };
  }
  return { supported: false, cancelled: false, path: null };
}

let inFlightBrowse: Promise<BrowseWorkspaceResult> | null = null;

export async function pickNativeFolder(rawInitialDir?: string): Promise<BrowseWorkspaceResult> {
  if (inFlightBrowse) return inFlightBrowse;

  const run = async (): Promise<BrowseWorkspaceResult> => {
    const initialDir = resolveInitialBrowseDir(rawInitialDir);
    switch (process.platform) {
      case 'win32':
        return pickWindowsFolder(initialDir);
      case 'darwin':
        return pickMacFolder(initialDir);
      case 'linux':
        return pickLinuxFolder(initialDir);
      default:
        return { supported: false, cancelled: false, path: null };
    }
  };

  inFlightBrowse = run().finally(() => {
    inFlightBrowse = null;
  });
  return inFlightBrowse;
}

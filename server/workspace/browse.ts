import { execFile, type ChildProcess } from 'node:child_process';
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

let activeBrowseCancel: (() => void) | null = null;

export function cancelNativeFolderBrowse(): boolean {
  if (!activeBrowseCancel) return false;
  activeBrowseCancel();
  return true;
}

function killDialogChild(child: ChildProcess) {
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {
      // Fall back to Node child.kill below.
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore already-exited child.
  }
  if (process.platform !== 'win32') {
    const t = setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // Ignore already-exited child.
      }
    }, 150);
    t.unref?.();
  }
}

function runDialogFile(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<{ code: number | null; stdout: string; stderr: string; enoent: boolean; cancelled: boolean }> {
  if (signal?.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', enoent: false, cancelled: true });
  }
  return new Promise((resolve) => {
    let settled = false;
    let childRef: ChildProcess | null = null;

    const finish = (res: { code: number | null; stdout: string; stderr: string; enoent: boolean; cancelled: boolean }) => {
      if (settled) return;
      settled = true;
      if (activeBrowseCancel === cancel) activeBrowseCancel = null;
      signal?.removeEventListener('abort', cancel);
      resolve(res);
    };

    const cancel = () => {
      if (settled) return;
      if (childRef) killDialogChild(childRef);
      finish({ code: null, stdout: '', stderr: '', enoent: false, cancelled: true });
    };

    activeBrowseCancel = cancel;
    signal?.addEventListener('abort', cancel, { once: true });

    childRef = execFile(
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
        if (settled) return;
        if (!err) {
          finish({ code: 0, stdout: stdout || '', stderr: stderr || '', enoent: false, cancelled: false });
          return;
        }
        const e = err as { code?: string | number; message?: string };
        const enoent = e.code === 'ENOENT';
        const code = typeof e.code === 'number' ? e.code : 1;
        finish({ code, stdout: stdout || '', stderr: stderr || e.message || '', enoent, cancelled: false });
      }
    );
  });
}

async function pickWindowsFolder(initialDir?: string, signal?: AbortSignal): Promise<BrowseWorkspaceResult> {
  // Uses Windows' modern IFileOpenDialog (FOS_PICKFOLDERS — same Explorer dialog as VS Code)
  // hosted on a shown HWND_TOPMOST transparent owner so it always appears in front of the browser.
  // Falls back to OpenFileDialog if Add-Type compilation is blocked by policy.
  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$initialDir = $env:GEMMAVAULT_INITIAL_DIR

$csharp = @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace GemmaVaultNative {
  public static class FolderPicker {
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    private delegate bool EnumThreadWndProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumThreadWindows(uint dwThreadId, EnumThreadWndProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW {}

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog {
      [PreserveSig] int Show(IntPtr parent);
      void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
      void SetFileTypeIndex(uint iFileType);
      void GetFileTypeIndex(out uint piFileType);
      void Advise(IntPtr pfde, out uint pdwCookie);
      void Unadvise(uint dwCookie);
      void SetOptions(uint fos);
      void GetOptions(out uint pfos);
      void SetDefaultFolder(IShellItem psi);
      void SetFolder(IShellItem psi);
      void GetFolder(out IShellItem ppsi);
      void GetCurrentSelection(out IShellItem ppsi);
      void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
      void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
      void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
      void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
      void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
      void GetResult(out IShellItem ppsi);
      void AddPlace(IShellItem psi, int fdap);
      void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
      void Close(int hr);
      void SetClientGuid(ref Guid guid);
      void ClearClientData();
      void SetFilter(IntPtr pFilter);
      void GetResults(out IntPtr ppenum);
      void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
      void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
      void GetParent(out IShellItem ppsi);
      void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
      void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
      void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    private static void ForceToForeground(IntPtr hWnd) {
      if (hWnd == IntPtr.Zero) return;
      IntPtr fg = GetForegroundWindow();
      uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, IntPtr.Zero) : 0;
      uint curThread = GetCurrentThreadId();
      bool attached = false;
      try {
        if (fgThread != 0 && fgThread != curThread) {
          attached = AttachThreadInput(curThread, fgThread, true);
        }
        ShowWindow(hWnd, 5);
        SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
        SetForegroundWindow(hWnd);
        BringWindowToTop(hWnd);
        SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
        SetForegroundWindow(hWnd);
      } finally {
        if (attached) AttachThreadInput(curThread, fgThread, false);
      }
    }

    private static Timer StartDialogActivator(IntPtr ownerHandle) {
      uint curThread = GetCurrentThreadId();
      int attempts = 0;
      var timer = new Timer();
      timer.Interval = 60;
      timer.Tick += delegate {
        attempts++;
        IntPtr found = IntPtr.Zero;
        EnumThreadWindows(curThread, delegate(IntPtr hWnd, IntPtr lParam) {
          if (hWnd != ownerHandle && IsWindowVisible(hWnd)) {
            found = hWnd;
            return false;
          }
          return true;
        }, IntPtr.Zero);
        if (found != IntPtr.Zero) {
          ForceToForeground(found);
          timer.Stop();
        } else if (attempts >= 25) {
          timer.Stop();
        }
      };
      timer.Start();
      return timer;
    }

    private static void FocusOwner(Form owner) {
      IntPtr fg = GetForegroundWindow();
      var area = fg != IntPtr.Zero
        ? Screen.FromHandle(fg).WorkingArea
        : Screen.PrimaryScreen.WorkingArea;
      int cx = area.Left + (area.Width / 2);
      int cy = area.Top + (area.Height / 2);
      owner.Location = new Point(cx, cy);
      owner.Show();
      ForceToForeground(owner.Handle);
      owner.Activate();
    }

    public static string Pick(string initialDir) {
      using (var owner = new Form()) {
        owner.ShowInTaskbar = false;
        owner.FormBorderStyle = FormBorderStyle.None;
        owner.StartPosition = FormStartPosition.Manual;
        owner.Size = new Size(1, 1);
        owner.TopMost = true;
        owner.Opacity = 0.0;
        FocusOwner(owner);

        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        IShellItem folderItem = null;
        IShellItem result = null;
        Timer activator = null;
        try {
          uint options;
          dialog.GetOptions(out options);
          dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
          dialog.SetTitle("Select Project Folder");

          if (!string.IsNullOrWhiteSpace(initialDir) && Directory.Exists(initialDir)) {
            Guid shellItemGuid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref shellItemGuid, out folderItem) == 0 && folderItem != null) {
              dialog.SetFolder(folderItem);
            }
          }

          activator = StartDialogActivator(owner.Handle);
          int hr = dialog.Show(owner.Handle);
          if (hr == ERROR_CANCELLED) return null;
          if (hr != 0) Marshal.ThrowExceptionForHR(hr);

          dialog.GetResult(out result);
          if (result == null) return null;
          string path;
          result.GetDisplayName(SIGDN_FILESYSPATH, out path);
          return path;
        } finally {
          if (activator != null) {
            activator.Stop();
            activator.Dispose();
          }
          if (result != null) Marshal.FinalReleaseComObject(result);
          if (folderItem != null) Marshal.FinalReleaseComObject(folderItem);
          Marshal.FinalReleaseComObject(dialog);
        }
      }
    }
  }
}
'@

$picked = $null
$usedModern = $false
try {
  Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop
  $usedModern = $true
  $picked = [GemmaVaultNative.FolderPicker]::Pick($initialDir)
} catch {
  $usedModern = $false
}

if (-not $usedModern) {
  $owner = New-Object System.Windows.Forms.Form
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $owner.Location = New-Object System.Drawing.Point(($area.Left + [int]($area.Width / 2)), ($area.Top + [int]($area.Height / 2)))
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.TopMost = $true
  $owner.Opacity = 0.0
  $owner.Show()
  $owner.Activate()

  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = 'Select Project Folder'
  $dlg.ValidateNames = $false
  $dlg.CheckFileExists = $false
  $dlg.CheckPathExists = $true
  $dlg.FileName = 'Folder Selection.'
  if ($initialDir -and (Test-Path -LiteralPath $initialDir -PathType Container)) {
    $dlg.InitialDirectory = $initialDir
  }
  if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.FileName) {
    $picked = [System.IO.Path]::GetDirectoryName($dlg.FileName)
  }
  $dlg.Dispose()
  $owner.Dispose()
}

if ($picked) {
  [Console]::Write($picked)
}
`.trim();

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const res = await runDialogFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    initialDir ? { GEMMAVAULT_INITIAL_DIR: initialDir } : undefined,
    signal
  );

  if (res.cancelled) return { supported: true, cancelled: true, path: null };
  if (res.enoent || res.code !== 0) {
    return { supported: false, cancelled: false, path: null };
  }
  const picked = normalizePickedPath(res.stdout, 'win32');
  return picked
    ? { supported: true, cancelled: false, path: picked }
    : { supported: true, cancelled: true, path: null };
}

async function pickMacFolder(initialDir?: string, signal?: AbortSignal): Promise<BrowseWorkspaceResult> {
  const script = initialDir
    ? [
        'set initDir to system attribute "GEMMAVAULT_INITIAL_DIR"',
        'POSIX path of (choose folder with prompt "Select a project folder for GemmaVault" default location (POSIX file initDir))',
      ].join('\n')
    : 'POSIX path of (choose folder with prompt "Select a project folder for GemmaVault")';

  const res = await runDialogFile(
    'osascript',
    ['-e', script],
    initialDir ? { GEMMAVAULT_INITIAL_DIR: initialDir } : undefined,
    signal
  );

  if (res.cancelled) return { supported: true, cancelled: true, path: null };
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

async function pickLinuxFolder(initialDir?: string, signal?: AbortSignal): Promise<BrowseWorkspaceResult> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { supported: false, cancelled: false, path: null };
  }

  const zenityArgs = ['--file-selection', '--directory', '--title=Select a project folder for GemmaVault'];
  if (initialDir) zenityArgs.push(`--filename=${initialDir.replace(/\/+$/, '')}/`);
  const zenity = await runDialogFile('zenity', zenityArgs, undefined, signal);
  if (zenity.cancelled) return { supported: true, cancelled: true, path: null };
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
  const kdialog = await runDialogFile('kdialog', kdialogArgs, undefined, signal);
  if (kdialog.cancelled) return { supported: true, cancelled: true, path: null };
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

export async function pickNativeFolder(rawInitialDir?: string, signal?: AbortSignal): Promise<BrowseWorkspaceResult> {
  if (signal?.aborted) {
    cancelNativeFolderBrowse();
    return { supported: true, cancelled: true, path: null };
  }
  if (inFlightBrowse) return inFlightBrowse;

  const run = async (): Promise<BrowseWorkspaceResult> => {
    const initialDir = resolveInitialBrowseDir(rawInitialDir);
    switch (process.platform) {
      case 'win32':
        return pickWindowsFolder(initialDir, signal);
      case 'darwin':
        return pickMacFolder(initialDir, signal);
      case 'linux':
        return pickLinuxFolder(initialDir, signal);
      default:
        return { supported: false, cancelled: false, path: null };
    }
  };

  inFlightBrowse = run().finally(() => {
    inFlightBrowse = null;
  });
  return inFlightBrowse;
}

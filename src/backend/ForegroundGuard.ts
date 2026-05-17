import { spawn } from "child_process";

/**
 * Captures the current Windows foreground window before a potentially
 * focus-stealing operation, then restores it afterward. Used to keep the
 * user's foreground app (game, browser, etc.) on top even when something
 * we do raises VS Code.
 *
 * No-op on non-Windows platforms.
 *
 * Restoration uses the AttachThreadInput trick to bypass Windows'
 * foreground lock — SetForegroundWindow normally refuses to honor calls
 * from a process that doesn't already own the foreground, but attaching
 * to the foreground thread's input queue temporarily grants permission.
 */
export class ForegroundGuard {
  /** Returns an opaque token (the previous HWND) or null when unavailable. */
  public static async capture(): Promise<string | null> {
    if (process.platform !== "win32") return null;
    try {
      const out = await runPowerShell(CAPTURE_SCRIPT);
      const trimmed = out.trim();
      if (!trimmed || trimmed === "0") return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  /** Restore the foreground window captured by {@link capture}. */
  public static async restore(token: string | null): Promise<void> {
    if (!token || process.platform !== "win32") return;
    try {
      await runPowerShell(buildRestoreScript(token));
    } catch {
      // Best-effort. The game window will lose focus this once but the
      // user can click back. Not worth surfacing.
    }
  }

  /** Convenience wrapper: capture, run `fn`, restore. */
  public static async withSavedForeground<T>(fn: () => Promise<T>): Promise<T> {
    const token = await ForegroundGuard.capture();
    try {
      return await fn();
    } finally {
      if (token) {
        // Brief delay so the focus-stealing call has time to fully resolve
        // before we yank focus back — otherwise the target window can
        // re-raise itself a frame later and win the race.
        await new Promise((r) => setTimeout(r, 80));
        await ForegroundGuard.restore(token);
      }
    }
  }
}

const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace LBN -Name FgCap -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
"@ | Out-Null
$h = [LBN.FgCap]::GetForegroundWindow()
Write-Output ($h.ToInt64())
`.trim();

function buildRestoreScript(hwndStr: string): string {
  // Numeric validation — the token comes from our own capture script but
  // belt-and-suspenders since it's interpolated into a PowerShell string.
  const numeric = /^-?\d+$/.test(hwndStr) ? hwndStr : "0";
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace LBN -Name FgRestore -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
"@ | Out-Null

$target = [System.IntPtr]::new([long]${numeric})
if (-not [LBN.FgRestore]::IsWindow($target)) { exit 0 }

# If the target was minimized when we captured it (shouldn't happen, but
# guard anyway), don't restore minimized — just bail.
if ([LBN.FgRestore]::IsIconic($target)) { exit 0 }

$fg = [LBN.FgRestore]::GetForegroundWindow()
if ($fg -eq $target) { exit 0 }

$fgPid = 0
$null = [LBN.FgRestore]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$fgThread = $null
if ($fgPid -ne 0) {
  $fgThread = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).Threads | Select-Object -First 1 -ExpandProperty Id
}
$curThread = [LBN.FgRestore]::GetCurrentThreadId()
$attached = $false
if ($fgThread -ne $null -and $fgThread -ne $curThread) {
  $attached = [LBN.FgRestore]::AttachThreadInput($curThread, [uint32]$fgThread, $true)
}
[void][LBN.FgRestore]::SetForegroundWindow($target)
if ($attached) {
  [void][LBN.FgRestore]::AttachThreadInput($curThread, [uint32]$fgThread, $false)
}
`.trim();
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`powershell exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

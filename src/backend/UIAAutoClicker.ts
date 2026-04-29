import { spawn } from "child_process";
import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";
import type { ActivityLog } from "./ActivityLog";

/**
 * UIAAutoClicker — Windows UI Automation strategy.
 *
 * Uses PowerShell + UIAutomationClient.dll to walk the accessibility tree of
 * VS Code's process(es), find a button by accessible Name (e.g. "Allow Once",
 * "Allow in this Session", "Keep"), and Invoke it via the InvokePattern
 * — no mouse movement, no fixed coordinates.
 *
 * Search is scoped to processes named "Code" (or any process names the user
 * configures via `lakeburner.uia.processNames`) so we cannot accidentally
 * trigger buttons in other applications.
 *
 * Returns the matched button's Name on success, null otherwise.
 */
export class UIAAutoClicker {
  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly activity: ActivityLog
  ) {}

  public static readonly DEFAULT_ALLOW_NAMES = [
    "Allow Once",
    "Allow in this Session",
    "Allow in this Workspace",
    "Allow",
    "Continue",
  ];

  public static readonly DEFAULT_KEEP_NAMES = [
    "Keep",
    "Apply",
    "Apply and next",
    "Accept",
    "Accept All",
  ];

  public isEnabled(): boolean {
    if (process.platform !== "win32") return false;
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    return cfg.get<boolean>("uia.enabled", true);
  }

  public async pressAllow(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressByName("allow", "Allow", this.getNames("allow"), opts);
  }

  public async pressKeep(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressByName("keep", "Keep", this.getNames("keep"), opts);
  }

  private getNames(intent: "allow" | "keep"): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const key = intent === "allow" ? "uia.allowButtonNames" : "uia.keepButtonNames";
    const raw = cfg.get<unknown>(key);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    return intent === "allow" ? UIAAutoClicker.DEFAULT_ALLOW_NAMES : UIAAutoClicker.DEFAULT_KEEP_NAMES;
  }

  private getProcessNames(): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("uia.processNames");
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    return ["Code", "Code - Insiders"];
  }

  private async pressByName(
    intent: "allow" | "keep",
    label: string,
    names: string[],
    opts: { silent?: boolean }
  ): Promise<string | null> {
    if (!this.isEnabled()) return null;

    const procs = this.getProcessNames();
    let result: { matchedName?: string; reason?: string };
    try {
      result = await runUIAFinder(names, procs);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!opts.silent) {
        this.logger.error({ fn: "pressByName" }, "UIA Script Failed", { intent, reason });
        this.activity.add("BLOCK", `UIA ${label} failed: ${reason}`, { strategy: "uia", intent });
      }
      return null;
    }

    if (result.matchedName) {
      this.logger.task({ fn: "pressByName" }, "UIA Invoked", { intent, name: result.matchedName });
      this.activity.add("APPROVE", `Pressed "${label}" via UIA: ${result.matchedName}`, {
        strategy: "uia",
        intent,
        name: result.matchedName,
      });
      return result.matchedName;
    }

    if (!opts.silent) {
      this.logger.info({ fn: "pressByName" }, "UIA Found No Match", { intent, names, reason: result.reason });
    }
    return null;
  }
}

function runUIAFinder(names: string[], processNames: string[]): Promise<{ matchedName?: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const namesJson = JSON.stringify(names);
    const procsJson = JSON.stringify(processNames);
    // PowerShell script: scope by process name, walk descendants, match the
    // first button whose Name equals one of the requested labels, then Invoke.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes  | Out-Null

$names = '${namesJson.replace(/'/g, "''")}' | ConvertFrom-Json
$procs = '${procsJson.replace(/'/g, "''")}' | ConvertFrom-Json

$pids = @()
foreach ($pn in $procs) {
  try { Get-Process -Name $pn -ErrorAction Stop | ForEach-Object { $pids += $_.Id } } catch {}
}
if ($pids.Count -eq 0) {
  Write-Output "NO_PROCESS"
  exit 0
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$buttonCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

# Per-PID windows (top-level). We scan only top-level windows of our PIDs to
# bound the search and avoid touching other apps.
$windowsByPid = @{}
foreach ($child in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                                  [System.Windows.Automation.Condition]::TrueCondition)) {
  try {
    $childPid = $child.Current.ProcessId
    if ($pids -contains $childPid) {
      if (-not $windowsByPid.ContainsKey($childPid)) { $windowsByPid[$childPid] = @() }
      $windowsByPid[$childPid] += $child
    }
  } catch {}
}
if ($windowsByPid.Keys.Count -eq 0) {
  Write-Output "NO_WINDOW"
  exit 0
}

$matched = $null
foreach ($wins in $windowsByPid.Values) {
  foreach ($win in $wins) {
    $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCond)
    foreach ($btn in $buttons) {
      try {
        $btnName = $btn.Current.Name
        if (-not $btnName) { continue }
        if ($names -contains $btnName) {
          # Only invoke if enabled AND offscreen=false.
          if ($btn.Current.IsEnabled -and -not $btn.Current.IsOffscreen) {
            $invokePatternObj = $null
            if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePatternObj)) {
              $invokePatternObj.Invoke()
              $matched = $btnName
              break
            }
          }
        }
      } catch {}
    }
    if ($matched) { break }
  }
  if ($matched) { break }
}

if ($matched) { Write-Output ("MATCH:" + $matched) } else { Write-Output "NO_MATCH" }
`.trim();

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`powershell exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const out = stdout.trim();
      if (out.startsWith("MATCH:")) {
        resolve({ matchedName: out.slice("MATCH:".length).trim() });
      } else if (out === "NO_MATCH" || out === "NO_PROCESS" || out === "NO_WINDOW") {
        resolve({ reason: out });
      } else {
        resolve({ reason: out || "EMPTY" });
      }
    });
  });
}

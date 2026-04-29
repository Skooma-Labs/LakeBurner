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

  public static readonly DEFAULT_BUSY_NAMES = [
    // Names of buttons VS Code shows in the chat input box / chat header
    // while the assistant is actively generating. If any of these is present
    // and enabled the chat is NOT idle and we must not send a Keep Going.
    "Cancel",
    "Stop",
    "Stop generating",
    "Cancel request",
    "Cancel Editing Session",
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

  /**
   * Probe-only UIA scan: returns the matched button name if a chat "busy"
   * indicator (Cancel / Stop / Stop generating) is present and enabled,
   * else null. Does NOT invoke any control. Used by AutoRunTicker to avoid
   * sending the Keep Going prompt while an assistant is still streaming.
   */
  public async findBusyIndicator(opts: { silent?: boolean } = {}): Promise<string | null> {
    if (!this.isEnabled()) return null;
    const names = this.getBusyNames();
    const procs = this.getProcessNames();
    let result: UIAResult;
    try {
      result = await runUIAFinder(names, procs, { probeOnly: true, exactOnly: true });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!opts.silent) {
        this.activity.add("INFO", `UIA busy probe failed to launch: ${reason}`, { strategy: "uia", probe: "busy" });
      }
      return null;
    }
    return result.matchedName ?? null;
  }

  private getBusyNames(): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("uia.busyButtonNames");
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    return UIAAutoClicker.DEFAULT_BUSY_NAMES;
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
    if (!this.isEnabled()) {
      if (!opts.silent) {
        this.activity.add("INFO", `UIA disabled (platform=${process.platform}, uia.enabled=false?)`, { strategy: "uia", intent });
      }
      return null;
    }

    const procs = this.getProcessNames();
    let result: UIAResult;
    try {
      result = await runUIAFinder(names, procs);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!opts.silent) {
        this.logger.error({ fn: "pressByName" }, "UIA Script Failed", { intent, reason });
        this.activity.add("BLOCK", `UIA ${label} failed to launch: ${reason}`, { strategy: "uia", intent });
      }
      return null;
    }

    const d = result.diagnostics;
    if (result.matchedName) {
      this.logger.task({ fn: "pressByName" }, "UIA Invoked", { intent, name: result.matchedName, diagnostics: d });
      this.activity.add(
        "APPROVE",
        `UIA pressed "${label}": ${result.matchedName} (procs=${d.pids.length}, wins=${d.windowCount}, controls=${d.controlCount}, ${d.elapsedMs}ms)`,
        { strategy: "uia", intent, name: result.matchedName, diagnostics: d, names }
      );
      return result.matchedName;
    }

    if (!opts.silent) {
      const sampleStr = d.candidates.length ? ` candidates: ${d.candidates.slice(0, 12).join(" | ")}` : "";
      const errStr = d.error ? ` error: ${d.error}` : "";
      this.logger.info({ fn: "pressByName" }, "UIA Found No Match", { intent, names, result });
      this.activity.add(
        "INFO",
        `UIA ${label} ${result.reason ?? "no match"} (procs=${d.pids.length}, wins=${d.windowCount}, controls=${d.controlCount}, ${d.elapsedMs}ms).${sampleStr}${errStr}`,
        { strategy: "uia", intent, reason: result.reason, names, diagnostics: d }
      );
    }
    return null;
  }
}

type UIAResult = {
  matchedName?: string;
  reason?: string;
  diagnostics: {
    procs: string[];
    pids: number[];
    windowCount: number;
    controlCount: number;
    candidates: string[];
    elapsedMs: number;
    error?: string;
  };
};

function runUIAFinder(names: string[], processNames: string[], opts: { probeOnly?: boolean; exactOnly?: boolean } = {}): Promise<UIAResult> {
  return new Promise((resolve, reject) => {
    const namesJson = JSON.stringify(names);
    const procsJson = JSON.stringify(processNames);
    const probeOnly = opts.probeOnly ? "$true" : "$false";
    const exactOnly = opts.exactOnly ? "$true" : "$false";
    const startedAt = Date.now();
    // PowerShell: scope by process, walk descendants, return JSON with the
    // matched name (if any) plus diagnostics about what UIA actually saw.
    const script = `
$ErrorActionPreference = 'Stop'
# Force stdout to UTF-8 — VS Code's button labels use smart quotes
# (U+201C, U+201D) which would otherwise be mangled by the default
# Windows codepage and corrupt our JSON output.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes  | Out-Null

$names = '${namesJson.replace(/'/g, "''")}' | ConvertFrom-Json
$procs = '${procsJson.replace(/'/g, "''")}' | ConvertFrom-Json
$probeOnly = ${probeOnly}
$exactOnly = ${exactOnly}

$diag = @{
  pids = @()
  windowCount = 0
  controlCount = 0
  candidates = @()
  matched = $null
  reason = $null
}

$pids = @()
foreach ($pn in $procs) {
  try { Get-Process -Name $pn -ErrorAction Stop | ForEach-Object { $pids += $_.Id } } catch {}
}
$diag.pids = $pids
if ($pids.Count -eq 0) {
  $diag.reason = "NO_PROCESS"
  $diag | ConvertTo-Json -Compress -Depth 5
  exit 0
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$typesToSearch = @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::SplitButton,
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::MenuItem
)
$typeConds = @()
foreach ($t in $typesToSearch) {
  $typeConds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $t)
}
$searchCond = New-Object System.Windows.Automation.OrCondition($typeConds)

$windowsByPid = @{}
foreach ($child in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  try {
    $childPid = $child.Current.ProcessId
    if ($pids -contains $childPid) {
      if (-not $windowsByPid.ContainsKey($childPid)) { $windowsByPid[$childPid] = @() }
      $windowsByPid[$childPid] += $child
    }
  } catch {}
}
$winCount = 0
foreach ($v in $windowsByPid.Values) { $winCount += $v.Count }
$diag.windowCount = $winCount
if ($winCount -eq 0) {
  $diag.reason = "NO_WINDOW"
  $diag | ConvertTo-Json -Compress -Depth 5
  exit 0
}

$normNames = @()
foreach ($n in $names) { if ($n) { $normNames += $n.ToString().Trim().ToLowerInvariant() } }

# Names of controls we will NEVER click — primarily LakeBurner's own
# sidebar buttons whose accessible names contain "Allow" / "Keep" as
# substrings. Without this guard the ticker clicks our own UI on every
# scan, which then re-enters pressAllow / pressKeep, looping forever.
$excludePrefixes = @("press ")

$matched = $null
$candidates = New-Object System.Collections.Generic.HashSet[string]
$totalControls = 0
foreach ($wins in $windowsByPid.Values) {
  foreach ($win in $wins) {
    $controls = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $searchCond)
    $totalControls += $controls.Count
    foreach ($ctrl in $controls) {
      try {
        $ctrlName = $ctrl.Current.Name
        if (-not $ctrlName) { continue }
        $normCtrl = $ctrlName.Trim().ToLowerInvariant()
        if (-not $normCtrl) { continue }
        $excluded = $false
        foreach ($pfx in $excludePrefixes) {
          if ($normCtrl.StartsWith($pfx)) { $excluded = $true; break }
        }
        if ($excluded) {
          if ($candidates.Count -lt 60) { [void]$candidates.Add($ctrlName) }
          continue
        }
        $hit = $false
        foreach ($wanted in $normNames) {
          # Equals or StartsWith only — Contains is far too loose. It used
          # to match "Press \"Allow\"" against "Allow" and click our own UI.
          if ($exactOnly) {
            if ($normCtrl -eq $wanted) { $hit = $true; break }
          } elseif ($normCtrl -eq $wanted -or $normCtrl.StartsWith($wanted)) {
            $hit = $true
            break
          }
        }
        if (-not $hit) {
          if ($candidates.Count -lt 60) { [void]$candidates.Add($ctrlName) }
          continue
        }
        if (-not $ctrl.Current.IsEnabled -or $ctrl.Current.IsOffscreen) { continue }
        if ($probeOnly) {
          # Just record the match; do not Invoke.
          $matched = $ctrlName
          break
        }
        $invokePatternObj = $null
        if ($ctrl.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePatternObj)) {
          $invokePatternObj.Invoke()
          $matched = $ctrlName
          break
        }
        $togglePatternObj = $null
        if ($ctrl.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$togglePatternObj)) {
          $togglePatternObj.Toggle()
          $matched = $ctrlName
          break
        }
      } catch {}
    }
    if ($matched) { break }
  }
  if ($matched) { break }
}
$diag.controlCount = $totalControls
$diag.candidates = @($candidates | Select-Object -First 30)
if ($matched) {
  $diag.matched = $matched
  $diag.reason = "MATCH"
} else {
  $diag.reason = "NO_MATCH"
}
$diag | ConvertTo-Json -Compress -Depth 5
`.trim();

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
      const elapsedMs = Date.now() - startedAt;
      const baseDiag = {
        procs: processNames,
        pids: [] as number[],
        windowCount: 0,
        controlCount: 0,
        candidates: [] as string[],
        elapsedMs,
      };
      if (code !== 0) {
        resolve({
          reason: "SCRIPT_ERROR",
          diagnostics: { ...baseDiag, error: stderr.trim() || stdout.trim() || `exit ${code}` },
        });
        return;
      }
      const out = stdout.trim();
      try {
        const parsed = JSON.parse(out) as {
          pids?: number[];
          windowCount?: number;
          controlCount?: number;
          candidates?: string[];
          matched?: string | null;
          reason?: string;
        };
        resolve({
          matchedName: parsed.matched ?? undefined,
          reason: parsed.reason,
          diagnostics: {
            ...baseDiag,
            pids: parsed.pids ?? [],
            windowCount: parsed.windowCount ?? 0,
            controlCount: parsed.controlCount ?? 0,
            candidates: parsed.candidates ?? [],
          },
        });
      } catch (parseErr) {
        resolve({
          reason: "PARSE_ERROR",
          diagnostics: { ...baseDiag, error: `${(parseErr as Error).message}; raw=${out.slice(0, 500)}` },
        });
      }
    });
  });
}

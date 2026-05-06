import { spawn } from "child_process";
import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";
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
    // Substrings (case-insensitive) the busy probe scans for across all chat
    // controls. Any positive match means the chat is NOT idle and we must
    // not send Keep Going. The probe runs in `containsMode` and over a wider
    // set of control types (Button + Text + Group + ProgressBar) so it can
    // catch the "Loading", "QUEUED", and "Generating" inline indicators VS
    // Code shows while a request is streaming or queued.
    //
    // Be intentionally conservative — false positives (think busy when not)
    // are harmless (we just wait longer); false negatives are catastrophic
    // (we queue on top of an active generation).
    "stop",
    "cancel",
    "loading",
    "queued",
    "generating",
    "working",
    "thinking",
    "running",
    // Tool-execution phases. Copilot tool calls don't always show a Stop
    // button between sub-steps; instead the chat surfaces gerunds like
    // "Preparing", "Creating file", "Analyzing". Without these, the idle
    // countdown ticks straight through tool execution and we queue mid-run.
    "preparing",
    "creating",
    "editing",
    "applying",
    "executing",
    "fetching",
    "analyzing",
    "saving",
    "searching",
    "processing",
  ];

  /**
   * Substring patterns applied as exclusions during the busy scan. Any
   * control whose normalized name matches one of these is ignored even if
   * it would otherwise be a busy-keyword hit. This filters out workbench
   * chrome (debug toolbar buttons, our own sidebar, etc.) so they cannot
   * be misread as chat activity.
   */
  public static readonly DEFAULT_BUSY_EXCLUDES = [
    "press \"",   // our own sidebar buttons (legacy, may be removed later)
    "press \u201c", // smart-quote variant
    "(shift+",   // debug toolbar shortcuts: Stop (Shift+F5), etc.
    "(ctrl+",
    "(alt+",
    "(f5)",
    "(f9)",
    "(f10)",
    "(f11)",
    "lakeburner",
    // LakeBurner activity-log phrases. Our own diagnostic text is rendered
    // inside the sidebar/popout webviews, where it surfaces as UIA Text
    // controls. The ancestor-name walk doesn't catch this \u2014 VS Code's
    // webview wrapping doesn't propagate the panel title down to every
    // descendant \u2014 so we filter by content instead. These phrases are
    // unmistakably LakeBurner-generated; no real chat will produce them.
    "stop button gone",
    "until generation stops",
    "since last stop button",
    "holding indefinitely",
    "idle confirmation",
    "idle confirmed",
    "ticker skipped",
    "ticker started",
    "ticker stopped",
    "tick #",
    "aborting keep going",
    "session armed",
    "session disarmed",
    "@lakeburner",
    "auto-run",
    "uia pressed",
    "uia busy probe",
    "uia allow",
    "uia keep",
    // Completed turns in existing chat transcripts can leave historical
    // elapsed-status text visible, e.g. "Working for 1m 17s". Those labels
    // are not reliable proof that the current composer is still generating;
    // a real active turn should still expose Stop/Cancel or a non-elapsed
    // live status that the busy probe can catch.
    "working for ",
    "thinking for ",
    "running for ",
    "generating for ",
    "processing for ",
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
    const excludes = this.getBusyExcludes();
    const procs = this.getProcessNames();
    let result: UIAResult;
    try {
      result = await runUIAFinder(names, procs, {
        probeOnly: true,
        containsMode: true,
        excludePatterns: excludes,
        widerControls: true,
      });
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
      return mergeConfiguredWithDefaults(raw, UIAAutoClicker.DEFAULT_BUSY_NAMES);
    }
    return UIAAutoClicker.DEFAULT_BUSY_NAMES;
  }

  private getBusyExcludes(): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("uia.busyExcludePatterns");
    if (Array.isArray(raw) && raw.length > 0) {
      return mergeConfiguredWithDefaults(raw, UIAAutoClicker.DEFAULT_BUSY_EXCLUDES);
    }
    return UIAAutoClicker.DEFAULT_BUSY_EXCLUDES;
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

function mergeConfiguredWithDefaults(raw: unknown[], defaults: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of [...raw, ...defaults]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function runUIAFinder(
  names: string[],
  processNames: string[],
  opts: {
    probeOnly?: boolean;
    exactOnly?: boolean;
    containsMode?: boolean;
    excludePatterns?: string[];
    widerControls?: boolean;
  } = {}
): Promise<UIAResult> {
  return new Promise((resolve, reject) => {
    const namesJson = JSON.stringify(names);
    const procsJson = JSON.stringify(processNames);
    const excludesJson = JSON.stringify(opts.excludePatterns ?? []);
    const probeOnly = opts.probeOnly ? "$true" : "$false";
    const exactOnly = opts.exactOnly ? "$true" : "$false";
    const containsMode = opts.containsMode ? "$true" : "$false";
    const widerControls = opts.widerControls ? "$true" : "$false";
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
$customExcludes = '${excludesJson.replace(/'/g, "''")}' | ConvertFrom-Json
$probeOnly = ${probeOnly}
$exactOnly = ${exactOnly}
$containsMode = ${containsMode}
$widerControls = ${widerControls}

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
if ($widerControls) {
  # Busy probe: include passive UI elements too. VS Code shows "Loading",
  # "QUEUED", and progress spinners as Text/Group/ProgressBar/Image, NOT
  # as buttons, so a button-only scan misses them entirely.
  $typesToSearch += [System.Windows.Automation.ControlType]::Text
  $typesToSearch += [System.Windows.Automation.ControlType]::Group
  $typesToSearch += [System.Windows.Automation.ControlType]::ProgressBar
  $typesToSearch += [System.Windows.Automation.ControlType]::Image
  $typesToSearch += [System.Windows.Automation.ControlType]::StatusBar
}
$typeConds = @()
foreach ($t in $typesToSearch) {
  $typeConds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $t)
}
$searchCond = New-Object System.Windows.Automation.OrCondition($typeConds)

# Walker used to climb parents from a hit so we can reject controls that
# live inside LakeBurner's own panel. Without this, our activity log text
# (e.g. "Chat busy (Working) ...") gets re-detected as a busy indicator
# on subsequent ticks and the probe never reports idle.
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

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

# Caller-supplied substring excludes (busy probe uses these to filter out
# debug-toolbar buttons whose names contain "(Shift+F5)" etc.).
$excludeSubstrings = @()
foreach ($e in $customExcludes) { if ($e) { $excludeSubstrings += $e.ToString().Trim().ToLowerInvariant() } }

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
        if (-not $excluded) {
          foreach ($sub in $excludeSubstrings) {
            if ($normCtrl.Contains($sub)) { $excluded = $true; break }
          }
        }
        if ($excluded) {
          if ($candidates.Count -lt 60) { [void]$candidates.Add($ctrlName) }
          continue
        }
        $hit = $false
        foreach ($wanted in $normNames) {
          if ($containsMode) {
            # Probe mode: look for the keyword anywhere in the name. Used
            # only for the busy detector -- combined with the exclude list
            # this catches inline "Loading"/"QUEUED"/"Generating" labels.
            if ($normCtrl.Contains($wanted)) { $hit = $true; break }
          } elseif ($exactOnly) {
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
        # In probe mode we don't require IsEnabled — passive labels like
        # "Loading" and "QUEUED" are not enabled controls but still prove
        # the chat is active.
        if (-not $probeOnly) {
          if (-not $ctrl.Current.IsEnabled -or $ctrl.Current.IsOffscreen) { continue }
        } elseif ($ctrl.Current.IsOffscreen) {
          continue
        }
        # Walk up to 30 ancestors and skip the hit if any of them is the
        # LakeBurner panel. This stops the busy probe from getting stuck on
        # its own activity log entries (which legitimately contain words
        # like "working" / "stop"). PROBE ONLY — for press paths the check
        # is a footgun: if the workspace folder is named "LakeBurner", the
        # top-level VS Code window's accessible name contains "lakeburner"
        # and every Allow/Keep press inside that window gets filtered out.
        # Press paths only scan Button/SplitButton/Hyperlink/MenuItem and
        # our sidebar has no button literally named Allow/Keep, so press
        # can't false-positive on our UI to begin with.
        if ($probeOnly) {
          $inLakeBurnerPanel = $false
          try {
            $cur = $walker.GetParent($ctrl)
            $depth = 0
            while ($cur -ne $null -and $depth -lt 30) {
              try {
                $parentName = $cur.Current.Name
                if ($parentName) {
                  $normParent = $parentName.Trim().ToLowerInvariant()
                  # Match panels whose name STARTS WITH "lakeburner" (e.g.
                  # "LakeBurner", "LakeBurner — Activity"). Ignore the top
                  # window: its accessible name typically begins with the
                  # active file path or "[Extension Development Host]" and
                  # only contains "lakeburner" deeper in.
                  if ($normParent.StartsWith("lakeburner")) {
                    $inLakeBurnerPanel = $true
                    break
                  }
                }
              } catch {}
              $cur = $walker.GetParent($cur)
              $depth++
            }
          } catch {}
          if ($inLakeBurnerPanel) {
            if ($candidates.Count -lt 60) { [void]$candidates.Add($ctrlName) }
            continue
          }
        }
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

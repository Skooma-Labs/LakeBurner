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

  /**
   * Names of the chat-composer context-menu action that wipes any prompts
   * the user (or LakeBurner, on rare races) has queued behind the active
   * turn. We poll for these every tick — if VS Code exposes the item in
   * the accessibility tree (either inline as a button or in an open menu),
   * we invoke it. When the option is not present (the normal case), the
   * scan returns null and we move on silently.
   *
   * Redundancy layer: even if the busy probe ever misses and a Nudge
   * Prompt slips into the queue, this catches it on the next tick.
   */
  public static readonly DEFAULT_REMOVE_QUEUED_NAMES = [
    "Remove All Queued",
    "Remove all queued",
    "Clear All Queued",
    "Clear all queued",
    "Cancel Queued",
    "Cancel queued",
    "Remove Queued Prompts",
    "Clear Queued Prompts",
  ];

  public static readonly DEFAULT_BUSY_NAMES = [
    // EXACT names of busy indicators. The probe matches case-insensitively
    // but requires the entire accessible name to equal one of these — chat
    // transcript Text controls contain full sentences, so they cannot
    // false-positive on a single-word status label. A previous broad
    // substring scan over transcript content stuck the probe in busy
    // forever; this list intentionally stays narrow.
    //
    // Composer cancel/stop button — primary signal in normal chat.
    "Cancel (Alt+BackSpace)",
    "Cancel chat request",
    "Stop generating",
    "Stop chat request",
    // Agent-mode standalone status labels. Required because in agent /
    // tool-orchestration mode the composer cancel button can briefly
    // disappear between sub-steps (e.g. while the model is "Evaluating"
    // a tool result) — a cancel-only probe declares idle in that window
    // and queues the nudge on top of an active turn. Include ellipsis
    // variants because VS Code renders these labels with U+2026 / "..."
    // depending on locale and chat type.
    "Evaluating",
    "Evaluating...",
    "Evaluating…",
    "Generating",
    "Generating...",
    "Generating…",
    "Thinking",
    "Thinking...",
    "Thinking…",
    "Working",
    "Working...",
    "Working…",
    "QUEUED",
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
    "(alt+",     // catches Alt+letter chrome (menu bar, view actions). The
                 // chat cancel button "Cancel (Alt+BackSpace)" would also
                 // be filtered here, so we whitelist it via DEFAULT_BUSY_OVERRIDES
                 // below, which is checked *before* this exclude list.
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

  /**
   * Substring whitelist applied BEFORE excludes during the busy scan. If a
   * control's normalized name contains any of these, it is treated as a
   * busy hit even if it would otherwise match an exclude pattern (e.g.
   * "(alt+" filters Alt-letter menu chrome, but the chat cancel button
   * "Cancel (Alt+BackSpace)" must still register).
   *
   * Keep this list narrow — anything here defeats the exclude safety net.
   */
  public static readonly DEFAULT_BUSY_OVERRIDES = [
    "cancel (alt+backspace)",
    "cancel chat request",
    "stop generating",
    "stop chat request",
  ];

  public isEnabled(): boolean {
    return process.platform === "win32";
  }

  public async pressAllow(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressByName("allow", "Allow", this.getNames("allow"), opts);
  }

  public async pressKeep(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressByName("keep", "Keep", this.getNames("keep"), opts);
  }

  /**
   * Best-effort scan for the "Remove All Queued" chat action. Returns the
   * matched control name on success, null when nothing matched (the common
   * case — the option only exists while there are queued prompts).
   */
  public async pressRemoveAllQueued(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressByName("removeQueued", "Remove All Queued", this.getRemoveQueuedNames(), opts);
  }

  /**
   * Probe-only UIA scan: returns the matched control name if any busy
   * indicator is present — composer cancel/stop button OR a standalone
   * agent-mode status label ("Evaluating...", "QUEUED", etc.) — else null.
   * EXACT name match, case-insensitive; does NOT use substring matching
   * over transcript text, which previously produced permanent false-
   * positives on conversational content. Does NOT invoke any control.
   * Used by AutoRunTicker to avoid sending the Keep Going prompt while an
   * assistant is still streaming or mid-tool-orchestration.
   */
  public async findBusyIndicator(opts: { silent?: boolean } = {}): Promise<string | null> {
    if (!this.isEnabled()) return null;
    const names = this.getBusyNames();
    const excludes = this.getBusyExcludes();
    const overrides = this.getBusyOverrides();
    const procs = this.getProcessNames();
    let result: UIAResult;
    try {
      result = await runUIAFinder(names, procs, {
        probeOnly: true,
        // Exact-name match against the busy-name list. We MUST NOT use
        // substring matching here — that scans transcript text and false-
        // positives on any conversational use of "stop", "running", etc.
        exactOnly: true,
        containsMode: false,
        excludePatterns: excludes,
        overridePatterns: overrides,
        // Include Text/Group/etc. controls so the standalone agent-mode
        // status labels ("Evaluating...", "QUEUED") are visible to the
        // scan. Exact-name match keeps this safe against transcript text.
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

  private getBusyOverrides(): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("uia.busyOverridePatterns");
    if (Array.isArray(raw) && raw.length > 0) {
      return mergeConfiguredWithDefaults(raw, UIAAutoClicker.DEFAULT_BUSY_OVERRIDES);
    }
    return UIAAutoClicker.DEFAULT_BUSY_OVERRIDES;
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

  private getRemoveQueuedNames(): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("uia.removeQueuedNames");
    if (Array.isArray(raw) && raw.length > 0) {
      return mergeConfiguredWithDefaults(raw, UIAAutoClicker.DEFAULT_REMOVE_QUEUED_NAMES);
    }
    return UIAAutoClicker.DEFAULT_REMOVE_QUEUED_NAMES;
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
    intent: string,
    label: string,
    names: string[],
    opts: { silent?: boolean }
  ): Promise<string | null> {
    if (!this.isEnabled()) {
      if (!opts.silent) {
        this.activity.add("INFO", `UIA unavailable (platform=${process.platform})`, { strategy: "uia", intent });
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
    overridePatterns?: string[];
    widerControls?: boolean;
  } = {}
): Promise<UIAResult> {
  return new Promise((resolve, reject) => {
    const namesJson = JSON.stringify(names);
    const procsJson = JSON.stringify(processNames);
    const excludesJson = JSON.stringify(opts.excludePatterns ?? []);
    const overridesJson = JSON.stringify(opts.overridePatterns ?? []);
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
$customOverrides = '${overridesJson.replace(/'/g, "''")}' | ConvertFrom-Json
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

# Caller-supplied override substrings — checked BEFORE excludes. A control
# whose normalized name contains any of these is treated as an immediate
# busy hit, bypassing both the exclude filter and the regular keyword scan.
# Used by the busy probe to whitelist the chat cancel button
# ("Cancel (Alt+BackSpace)") that would otherwise be caught by the "(alt+"
# exclude meant for Alt-letter menu chrome.
$overrideSubstrings = @()
foreach ($o in $customOverrides) { if ($o) { $overrideSubstrings += $o.ToString().Trim().ToLowerInvariant() } }

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
        # Override list wins against excludes. Anything matching here
        # short-circuits straight to "hit" — used for the chat cancel
        # button whose name contains the otherwise-excluded "(alt+".
        $hit = $false
        foreach ($ov in $overrideSubstrings) {
          if ($normCtrl.Contains($ov)) { $hit = $true; break }
        }
        if (-not $hit) {
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

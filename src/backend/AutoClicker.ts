import * as vscode from "vscode";
import { spawn } from "child_process";
import type { Logger } from "../frontend/ts/TSLogger";
import type { ActivityLog } from "./ActivityLog";
import type { UIAAutoClicker } from "./UIAAutoClicker";

/**
 * AutoClicker — best-effort "press the Keep button" pipeline.
 *
 * Strategy A (preferred): walk through a configurable list of VS Code command
 * IDs and execute the first one that doesn't throw. This is fully supported,
 * resilient to layout/DPI changes, and never moves the mouse.
 *
 * Strategy B (fallback): if every command failed AND the user has explicitly
 * opted into the coordinate fallback, spawn a short PowerShell script that
 * moves the OS mouse cursor to a calibrated (x, y) and synthesizes a left
 * click via user32::mouse_event. Brittle by design — provided as an escape
 * hatch when no command is exposed.
 *
 * Strategy B is OFF by default and requires:
 *   - lakeburner.autoClick.fallbackEnabled = true
 *   - lakeburner.autoClick.fallbackPosition.x and .y set
 *     (use the "LakeBurner: Calibrate Auto-Click Position" command)
 */
export class AutoClicker {
  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly activity: ActivityLog,
    private readonly context: vscode.ExtensionContext,
    private readonly uia: UIAAutoClicker
  ) {}

  // Defaults derived from GitHub Copilot Chat 0.45.x — see the Copilot Chat
  // package.json for the full list. Order matters: try the most specific /
  // most likely targets first.
  private static readonly DEFAULT_KEEP_COMMAND_IDS = [
    "github.copilot.chat.review.applyAndNext",
    "github.copilot.chat.review.apply",
    "github.copilot.chat.review.applyShort",
    "github.copilot.chat.copilotCLI.acceptDiff",
    "chat.action.acceptAll",
    "inlineChat.acceptChanges",
    "workbench.action.chat.applyAll",
  ];

  // Best-effort defaults for chat tool-confirmation prompts ("Allow Once",
  // "Allow in this Session", "Continue"). Public command coverage is thin,
  // so the coordinate fallback is the reliable lever for this intent.
  private static readonly DEFAULT_ALLOW_COMMAND_IDS = [
    "workbench.action.chat.acceptElicitation",
    "chat.action.acceptElicitation",
    "workbench.action.chat.acceptToolConfirmation",
    "chat.acceptToolConfirmation",
    "workbench.action.chat.confirm",
  ];

  private getCommandIds(intent: "keep" | "allow"): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const key = intent === "keep" ? "autoClick.commandIds" : "autoApprove.commandIds";
    const raw = cfg.get<unknown>(key);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    return intent === "keep" ? AutoClicker.DEFAULT_KEEP_COMMAND_IDS : AutoClicker.DEFAULT_ALLOW_COMMAND_IDS;
  }

  /**
   * Try the configured commands in order. Returns the ID of the command that
   * succeeded, or null if every attempt threw.
   *
   * Pass `{ silent: true }` to suppress activity-log + warn logging on misses
   * (used by the Auto-Run ticker so we don't spam the log every interval).
   */
  public async pressKeepViaCommand(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressIntentViaCommand("keep", "Keep", opts);
  }

  public async pressAllowViaCommand(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressIntentViaCommand("allow", "Allow", opts);
  }

  private async pressIntentViaCommand(
    intent: "keep" | "allow",
    label: string,
    opts: { silent?: boolean }
  ): Promise<string | null> {
    const ids = this.getCommandIds(intent);
    const attempts: { id: string; ok: boolean; reason?: string }[] = [];

    for (const id of ids) {
      try {
        await vscode.commands.executeCommand(id);
        attempts.push({ id, ok: true });
        this.logger.task({ fn: "pressIntentViaCommand" }, "Command Executed", { intent, id });
        this.activity.add("APPROVE", `Pressed "${label}" via command: ${id}`, { strategy: "command", intent });
        return id;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        attempts.push({ id, ok: false, reason });
        this.logger.info({ fn: "pressIntentViaCommand" }, "Command Skipped", { intent, id, reason });
      }
    }

    if (!opts.silent) {
      this.logger.warn({ fn: "pressIntentViaCommand" }, "No Command Succeeded", { intent, attempts });
    }
    return null;
  }

  /**
   * Run the OS-level click fallback for the given intent. Each intent has its
   * own calibrated position; the fallbackEnabled toggle is shared.
   */
  public async pressKeepViaCoordinates(opts: { silent?: boolean } = {}): Promise<boolean> {
    return this.pressIntentViaCoordinates("keep", "Keep", opts);
  }

  public async pressAllowViaCoordinates(opts: { silent?: boolean } = {}): Promise<boolean> {
    return this.pressIntentViaCoordinates("allow", "Allow", opts);
  }

  private async pressIntentViaCoordinates(
    intent: "keep" | "allow",
    label: string,
    opts: { silent?: boolean }
  ): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const enabled = cfg.get<boolean>("autoClick.fallbackEnabled", false);
    if (!enabled) {
      if (!opts.silent) this.logger.warn({ fn: "pressIntentViaCoordinates" }, "Coordinate Fallback Disabled", { intent });
      return false;
    }

    const posKey = intent === "keep" ? "autoClick.fallbackPosition" : "autoApprove.fallbackPosition";
    const pos = cfg.get<{ x?: number; y?: number }>(posKey, {});
    const x = typeof pos?.x === "number" ? Math.round(pos.x) : NaN;
    const y = typeof pos?.y === "number" ? Math.round(pos.y) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (!opts.silent) {
        this.logger.warn({ fn: "pressIntentViaCoordinates" }, "Position Not Calibrated", { intent });
        vscode.window.showWarningMessage(
          `LakeBurner: ${label} fallback position is not calibrated. Run "LakeBurner: Calibrate ${label} Click Position" first.`
        );
      }
      return false;
    }

    if (process.platform !== "win32") {
      if (!opts.silent) this.logger.warn({ fn: "pressIntentViaCoordinates" }, "Only Supported on Windows", { intent });
      return false;
    }

    try {
      await runPowerShellClick(x, y);
      this.logger.task({ fn: "pressIntentViaCoordinates" }, "OS Click Synthesized", { intent, x, y });
      this.activity.add("APPROVE", `Synthesized ${label} click at (${x}, ${y})`, { strategy: "coordinate", intent, x, y });
      return true;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!opts.silent) {
        this.logger.error({ fn: "pressIntentViaCoordinates" }, "OS Click Failed", { intent, reason });
        this.activity.add("BLOCK", `Coordinate ${label} click failed: ${reason}`, { strategy: "coordinate", intent });
      }
      return false;
    }
  }

  /**
   * Combined entry point — try commands first, then UIA (button-by-name within
   * VS Code's process), then the brittle fixed-coordinate fallback.
   */
  public async pressKeep(opts: { silent?: boolean } = {}): Promise<{ ok: boolean; via: "command" | "uia" | "coordinate" | "none"; commandId?: string; uiaName?: string }> {
    const commandId = await this.pressKeepViaCommand(opts);
    if (commandId) return { ok: true, via: "command", commandId };

    const uiaName = await this.uia.pressKeep(opts);
    if (uiaName) return { ok: true, via: "uia", uiaName };

    const ok = await this.pressKeepViaCoordinates(opts);
    return { ok, via: ok ? "coordinate" : "none" };
  }

  public async pressAllow(opts: { silent?: boolean } = {}): Promise<{ ok: boolean; via: "command" | "uia" | "coordinate" | "none"; commandId?: string; uiaName?: string }> {
    const commandId = await this.pressAllowViaCommand(opts);
    if (commandId) return { ok: true, via: "command", commandId };

    const uiaName = await this.uia.pressAllow(opts);
    if (uiaName) return { ok: true, via: "uia", uiaName };

    const ok = await this.pressAllowViaCoordinates(opts);
    return { ok, via: ok ? "coordinate" : "none" };
  }

  /**
   * Capture the current cursor position (after a 3-second countdown) and
   * persist it to settings. The user moves their mouse over the target button
   * during the countdown.
   */
  public async calibrateFallbackPosition(): Promise<void> {
    return this.calibrateIntentPosition("keep", "Keep", "autoClick.fallbackPosition");
  }

  public async calibrateAllowPosition(): Promise<void> {
    return this.calibrateIntentPosition("allow", "Allow", "autoApprove.fallbackPosition");
  }

  private async calibrateIntentPosition(intent: "keep" | "allow", label: string, settingKey: string): Promise<void> {
    if (process.platform !== "win32") {
      vscode.window.showErrorMessage("LakeBurner: Calibration is only supported on Windows.");
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `LakeBurner will capture the mouse position in 3 seconds. Move your cursor over the "${label}" button before the countdown ends.`,
      { modal: true },
      "Start Countdown"
    );
    if (choice !== "Start Countdown") return;

    for (let i = 3; i >= 1; i--) {
      vscode.window.setStatusBarMessage(`LakeBurner: capturing ${label} position in ${i}…`, 900);
      await delay(1000);
    }

    let pos: { x: number; y: number };
    try {
      pos = await readCursorPosition();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ fn: "calibrateIntentPosition" }, "Cursor Read Failed", { intent, reason });
      vscode.window.showErrorMessage(`LakeBurner: failed to read cursor position. ${reason}`);
      return;
    }

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    await cfg.update(settingKey, pos, vscode.ConfigurationTarget.Global);

    this.logger.task({ fn: "calibrateIntentPosition" }, "Calibration Saved", { intent, ...pos });
    this.activity.add("INFO", `Calibrated ${label} click position at (${pos.x}, ${pos.y})`);

    vscode.window.showInformationMessage(
      `LakeBurner: captured ${label} at (${pos.x}, ${pos.y}). Enable "lakeburner.autoClick.fallbackEnabled" to use it.`
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`powershell exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function readCursorPosition(): Promise<{ x: number; y: number }> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$p = [System.Windows.Forms.Cursor]::Position
Write-Output ("{0},{1}" -f $p.X, $p.Y)
`.trim();

  const out = await runPowerShell(script);
  const match = out.match(/(-?\d+)\s*,\s*(-?\d+)/);
  if (!match) throw new Error(`Unparseable cursor output: ${out}`);
  return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
}

async function runPowerShellClick(x: number, y: number): Promise<void> {
  // Add-Type emits a class once per session; in a fresh PS the cost is small.
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -Namespace LBN -Name Mouse -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
"@ | Out-Null

[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 60
[LBN.Mouse]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero) # LEFTDOWN
Start-Sleep -Milliseconds 30
[LBN.Mouse]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero) # LEFTUP
`.trim();

  await runPowerShell(script);
}

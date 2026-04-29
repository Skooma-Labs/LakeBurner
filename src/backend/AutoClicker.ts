import * as vscode from "vscode";
import { spawn } from "child_process";
import type { Logger } from "../frontend/ts/TSLogger";
import type { ActivityLog } from "./ActivityLog";

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
    private readonly context: vscode.ExtensionContext
  ) {}

  // Defaults derived from GitHub Copilot Chat 0.45.x — see the Copilot Chat
  // package.json for the full list. Order matters: try the most specific /
  // most likely targets first.
  private static readonly DEFAULT_COMMAND_IDS = [
    "github.copilot.chat.review.applyAndNext",
    "github.copilot.chat.review.apply",
    "github.copilot.chat.review.applyShort",
    "github.copilot.chat.copilotCLI.acceptDiff",
    "chat.action.acceptAll",
    "inlineChat.acceptChanges",
    "workbench.action.chat.applyAll",
  ];

  private getCommandIds(): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("autoClick.commandIds");
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    return AutoClicker.DEFAULT_COMMAND_IDS;
  }

  /**
   * Try the configured commands in order. Returns the ID of the command that
   * succeeded, or null if every attempt threw.
   */
  public async pressKeepViaCommand(): Promise<string | null> {
    const ids = this.getCommandIds();
    const attempts: { id: string; ok: boolean; reason?: string }[] = [];

    for (const id of ids) {
      try {
        await vscode.commands.executeCommand(id);
        attempts.push({ id, ok: true });
        this.logger.task({ fn: "pressKeepViaCommand" }, "Command Executed", { id });
        this.activity.add("APPROVE", `Pressed "Keep" via command: ${id}`, { strategy: "command" });
        return id;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        attempts.push({ id, ok: false, reason });
        this.logger.info({ fn: "pressKeepViaCommand" }, "Command Skipped", { id, reason });
      }
    }

    this.logger.warn({ fn: "pressKeepViaCommand" }, "No Keep Command Succeeded", { attempts });
    return null;
  }

  /**
   * Run the OS-level click fallback. Returns true on success, false otherwise.
   */
  public async pressKeepViaCoordinates(): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const enabled = cfg.get<boolean>("autoClick.fallbackEnabled", false);
    if (!enabled) {
      this.logger.warn({ fn: "pressKeepViaCoordinates" }, "Coordinate Fallback Disabled");
      return false;
    }

    const pos = cfg.get<{ x?: number; y?: number }>("autoClick.fallbackPosition", {});
    const x = typeof pos?.x === "number" ? Math.round(pos.x) : NaN;
    const y = typeof pos?.y === "number" ? Math.round(pos.y) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.logger.warn({ fn: "pressKeepViaCoordinates" }, "Coordinate Fallback Position Not Calibrated");
      vscode.window.showWarningMessage(
        "LakeBurner: Coordinate fallback is not calibrated. Run \"LakeBurner: Calibrate Auto-Click Position\" first."
      );
      return false;
    }

    if (process.platform !== "win32") {
      this.logger.warn({ fn: "pressKeepViaCoordinates" }, "Coordinate Fallback Only Supported on Windows");
      return false;
    }

    try {
      await runPowerShellClick(x, y);
      this.logger.task({ fn: "pressKeepViaCoordinates" }, "OS Click Synthesized", { x, y });
      this.activity.add("APPROVE", `Synthesized click at (${x}, ${y})`, { strategy: "coordinate", x, y });
      return true;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ fn: "pressKeepViaCoordinates" }, "OS Click Failed", { reason });
      this.activity.add("BLOCK", `Coordinate click failed: ${reason}`, { strategy: "coordinate" });
      return false;
    }
  }

  /**
   * Combined entry point — try commands first, fall back to coordinates if
   * every command failed AND the fallback is enabled.
   */
  public async pressKeep(): Promise<{ ok: boolean; via: "command" | "coordinate" | "none"; commandId?: string }> {
    const commandId = await this.pressKeepViaCommand();
    if (commandId) return { ok: true, via: "command", commandId };

    const ok = await this.pressKeepViaCoordinates();
    return { ok, via: ok ? "coordinate" : "none" };
  }

  /**
   * Capture the current cursor position (after a 3-second countdown) and
   * persist it to settings. The user moves their mouse over the Keep button
   * during the countdown.
   */
  public async calibrateFallbackPosition(): Promise<void> {
    if (process.platform !== "win32") {
      vscode.window.showErrorMessage("LakeBurner: Calibration is only supported on Windows.");
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      "LakeBurner will capture the mouse position in 3 seconds. Move your cursor over the Copilot \"Keep\" button before the countdown ends.",
      { modal: true },
      "Start Countdown"
    );
    if (choice !== "Start Countdown") return;

    for (let i = 3; i >= 1; i--) {
      vscode.window.setStatusBarMessage(`LakeBurner: capturing mouse in ${i}…`, 900);
      await delay(1000);
    }

    let pos: { x: number; y: number };
    try {
      pos = await readCursorPosition();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ fn: "calibrateFallbackPosition" }, "Cursor Read Failed", { reason });
      vscode.window.showErrorMessage(`LakeBurner: failed to read cursor position. ${reason}`);
      return;
    }

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    await cfg.update("autoClick.fallbackPosition", pos, vscode.ConfigurationTarget.Global);

    this.logger.task({ fn: "calibrateFallbackPosition" }, "Calibration Saved", pos);
    this.activity.add("INFO", `Calibrated auto-click position at (${pos.x}, ${pos.y})`);

    vscode.window.showInformationMessage(
      `LakeBurner: captured (${pos.x}, ${pos.y}). Enable "lakeburner.autoClick.fallbackEnabled" to use it.`
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

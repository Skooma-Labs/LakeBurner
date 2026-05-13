import * as vscode from "vscode";
import { spawn } from "child_process";
import type { Logger } from "../frontend/ts/Logger";
import type { ActivityLog } from "./ActivityLog";
import type { UIAAutoClicker } from "./UIAAutoClicker";

type ClickIntent = "keep" | "allow";
type PressResult = {
  ok: boolean;
  via: "command" | "uia" | "coordinate" | "none";
  commandId?: string;
  uiaName?: string;
};
type Point = { x: number; y: number };

const KEEP_POSITION_KEY = "lakeburner.autoClick.keepFallbackPosition.v1";
const ALLOW_POSITION_KEY = "lakeburner.autoClick.allowFallbackPosition.v1";

/**
 * Best-effort Allow/Keep button pipeline.
 *
 * The order is fixed application logic:
 *   1. UI Automation: visible button invoke, no mouse movement.
 *   2. VS Code command IDs: useful when an extension exposes a command path.
 *   3. Coordinate click: Windows-only final fallback when a calibrated point
 *      exists in extension state.
 *
 * The public Settings UI does not expose strategy toggles. Advanced command
 * ID arrays can still be supplied manually as hidden settings, and legacy
 * coordinate settings are migrated into extension state if present.
 */
export class AutoClicker {
  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly activity: ActivityLog,
    private readonly context: vscode.ExtensionContext,
    public readonly uia: UIAAutoClicker
  ) {}

  // Defaults derived from GitHub Copilot Chat command IDs. Order matters: try
  // the most specific / most likely targets first.
  private static readonly DEFAULT_KEEP_COMMAND_IDS = [
    "github.copilot.chat.review.applyAndNext",
    "github.copilot.chat.review.apply",
    "github.copilot.chat.review.applyShort",
    "github.copilot.chat.copilotCLI.acceptDiff",
    "chat.action.acceptAll",
    "inlineChat.acceptChanges",
    "workbench.action.chat.applyAll",
  ];

  private static readonly DEFAULT_ALLOW_COMMAND_IDS = [
    "workbench.action.chat.acceptElicitation",
    "chat.action.acceptElicitation",
    "workbench.action.chat.acceptToolConfirmation",
    "chat.acceptToolConfirmation",
    "workbench.action.chat.confirm",
  ];

  private getCommandIds(intent: ClickIntent): string[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const key = intent === "keep" ? "autoClick.commandIds" : "autoApprove.commandIds";
    const raw = cfg.get<unknown>(key);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    return intent === "keep" ? AutoClicker.DEFAULT_KEEP_COMMAND_IDS : AutoClicker.DEFAULT_ALLOW_COMMAND_IDS;
  }

  public async pressKeepViaCommand(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressIntentViaCommand("keep", "Keep", opts);
  }

  public async pressAllowViaCommand(opts: { silent?: boolean } = {}): Promise<string | null> {
    return this.pressIntentViaCommand("allow", "Allow", opts);
  }

  private async pressIntentViaCommand(
    intent: ClickIntent,
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

  public async pressKeepViaCoordinates(opts: { silent?: boolean } = {}): Promise<boolean> {
    return this.pressIntentViaCoordinates("keep", "Keep", opts);
  }

  public async pressAllowViaCoordinates(opts: { silent?: boolean } = {}): Promise<boolean> {
    return this.pressIntentViaCoordinates("allow", "Allow", opts);
  }

  private async pressIntentViaCoordinates(
    intent: ClickIntent,
    label: string,
    opts: { silent?: boolean }
  ): Promise<boolean> {
    const pos = await this.getCoordinatePosition(intent);
    if (!pos) {
      if (!opts.silent) this.logger.warn({ fn: "pressIntentViaCoordinates" }, "Position Not Calibrated", { intent });
      return false;
    }

    if (process.platform !== "win32") {
      if (!opts.silent) this.logger.warn({ fn: "pressIntentViaCoordinates" }, "Only Supported on Windows", { intent });
      return false;
    }

    try {
      await runPowerShellClick(pos.x, pos.y);
      this.logger.task({ fn: "pressIntentViaCoordinates" }, "OS Click Synthesized", { intent, x: pos.x, y: pos.y });
      this.activity.add("APPROVE", `Synthesized ${label} click at (${pos.x}, ${pos.y})`, {
        strategy: "coordinate",
        intent,
        x: pos.x,
        y: pos.y,
      });
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

  public async pressKeep(opts: { silent?: boolean; uiaOnly?: boolean } = {}): Promise<PressResult> {
    return this.pressIntent("keep", "Keep", opts);
  }

  public async pressAllow(opts: { silent?: boolean; uiaOnly?: boolean } = {}): Promise<PressResult> {
    return this.pressIntent("allow", "Allow", opts);
  }

  private async pressIntent(
    intent: ClickIntent,
    label: "Allow" | "Keep",
    opts: { silent?: boolean; uiaOnly?: boolean }
  ): Promise<PressResult> {
    const tried: string[] = [];

    tried.push("uia");
    const uiaName = intent === "keep" ? await this.uia.pressKeep(opts) : await this.uia.pressAllow(opts);
    if (uiaName) {
      this.logChainSummary(label, "uia", tried, opts, { uiaName });
      return { ok: true, via: "uia", uiaName };
    }

    if (opts.uiaOnly) {
      this.logChainSummary(label, "none", tried, opts);
      return { ok: false, via: "none" };
    }

    tried.push("command");
    const commandId = intent === "keep" ? await this.pressKeepViaCommand(opts) : await this.pressAllowViaCommand(opts);
    if (commandId) {
      this.logChainSummary(label, "command", tried, opts, { commandId });
      return { ok: true, via: "command", commandId };
    }

    tried.push("coordinate");
    const ok = intent === "keep" ? await this.pressKeepViaCoordinates(opts) : await this.pressAllowViaCoordinates(opts);
    this.logChainSummary(label, ok ? "coordinate" : "none", tried, opts);
    return { ok, via: ok ? "coordinate" : "none" };
  }

  private logChainSummary(
    label: "Allow" | "Keep",
    outcome: "command" | "uia" | "coordinate" | "none",
    tried: string[],
    opts: { silent?: boolean },
    extra: Record<string, unknown> = {}
  ): void {
    if (opts.silent) return;
    const kind = outcome === "none" ? "BLOCK" : "INFO";
    this.activity.add(
      kind,
      `Press ${label} chain: tried [${tried.join(" -> ")}] -> ${outcome}`,
      { strategy: "chain", label, outcome, tried, ...extra }
    );
  }

  public async calibrateFallbackPosition(): Promise<void> {
    return this.calibrateIntentPosition("keep", "Keep");
  }

  public async calibrateAllowPosition(): Promise<void> {
    return this.calibrateIntentPosition("allow", "Allow");
  }

  private async calibrateIntentPosition(intent: ClickIntent, label: string): Promise<void> {
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
      vscode.window.setStatusBarMessage(`LakeBurner: capturing ${label} position in ${i}...`, 900);
      await delay(1000);
    }

    let pos: Point;
    try {
      pos = await readCursorPosition();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ fn: "calibrateIntentPosition" }, "Cursor Read Failed", { intent, reason });
      vscode.window.showErrorMessage(`LakeBurner: failed to read cursor position. ${reason}`);
      return;
    }

    await this.context.globalState.update(this.positionStateKey(intent), pos);

    this.logger.task({ fn: "calibrateIntentPosition" }, "Calibration Saved", { intent, ...pos });
    this.activity.add("INFO", `Calibrated ${label} click position at (${pos.x}, ${pos.y})`);
    vscode.window.showInformationMessage(
      `LakeBurner: captured ${label} at (${pos.x}, ${pos.y}). Coordinate fallback will be used only if UIA and command pressing miss.`
    );
  }

  private async getCoordinatePosition(intent: ClickIntent): Promise<Point | null> {
    const stored = normalizePoint(this.context.globalState.get<Point>(this.positionStateKey(intent)));
    if (stored) return stored;

    const legacyKey = intent === "keep" ? "autoClick.fallbackPosition" : "autoApprove.fallbackPosition";
    const legacy = normalizePoint(vscode.workspace.getConfiguration(this.cfgSection).get<unknown>(legacyKey, {}));
    if (!legacy) return null;

    await this.context.globalState.update(this.positionStateKey(intent), legacy);
    this.logger.info({ fn: "getCoordinatePosition" }, "Migrated Legacy Coordinate Position", { intent, ...legacy });
    return legacy;
  }

  private positionStateKey(intent: ClickIntent): string {
    return intent === "keep" ? KEEP_POSITION_KEY : ALLOW_POSITION_KEY;
  }
}

function normalizePoint(value: unknown): Point | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { x?: unknown; y?: unknown };
  const x = typeof raw.x === "number" ? Math.round(raw.x) : NaN;
  const y = typeof raw.y === "number" ? Math.round(raw.y) : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
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

async function readCursorPosition(): Promise<Point> {
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

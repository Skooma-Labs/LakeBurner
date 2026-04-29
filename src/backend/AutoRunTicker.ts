import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";
import type { AutoRunMode } from "./AutoRunMode";
import type { AutoClicker } from "./AutoClicker";
import type { AffectedChats } from "./AffectedChats";
import type { ActivityLog } from "./ActivityLog";

/**
 * Drives the silent "press Allow + press Keep" loop while Auto-Run is on.
 * Polls every `lakeburner.autoRun.tickIntervalMs` (default 0; opt-in only).
 *
 * Guards (all must pass for a tick to fire):
 *   - Auto-Run is ON
 *   - tickIntervalMs > 0
 *   - VS Code window is focused (when requireWindowFocus = true)
 *   - At least one allow-listed chat session is on the list. The recent
 *     activity window only matters if it's a real ms value; once you arm
 *     a chat (Send Initial Prompt or @lakeburner start) it stays armed.
 */
export class AutoRunTicker implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastSkipReason: string | null = null;
  private lastSkipLoggedAt = 0;
  private tickCount = 0;
  private firedCount = 0;

  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly autoRun: AutoRunMode,
    private readonly autoClicker: AutoClicker,
    private readonly affected: AffectedChats,
    private readonly activity: ActivityLog
  ) {}

  public start(context: vscode.ExtensionContext): void {
    this.refresh();
    context.subscriptions.push(this.autoRun.onChange(() => this.refresh()));
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${this.cfgSection}.autoRun.tickIntervalMs`)) this.refresh();
      })
    );
    context.subscriptions.push(this);
  }

  private refresh(): void {
    this.stop();
    if (!this.autoRun.isEnabled) return;

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const interval = cfg.get<number>("autoRun.tickIntervalMs", 0);
    if (!Number.isFinite(interval) || interval <= 0) {
      this.activity.add("INFO", "Ticker disabled (autoRun.tickIntervalMs <= 0)", { intervalMs: interval });
      this.logger.info({ fn: "refresh" }, "Auto-Run Ticker Disabled (interval <= 0)");
      return;
    }

    this.activity.add("INFO", `Ticker started @ every ${interval}ms`, { intervalMs: interval });
    this.logger.task({ fn: "refresh" }, "Auto-Run Ticker Started", { intervalMs: interval });
    this.timer = setInterval(() => void this.tick(), interval);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.activity.add("INFO", "Ticker stopped");
      this.logger.info({ fn: "stop" }, "Auto-Run Ticker Stopped");
    }
  }

  /** Log a skip reason at most once per 10s, or whenever the reason changes. */
  private noteSkip(reason: string, data?: Record<string, unknown>): void {
    const now = Date.now();
    if (reason !== this.lastSkipReason || now - this.lastSkipLoggedAt > 10000) {
      this.activity.add("INFO", `Ticker skipped: ${reason}`, { tickCount: this.tickCount, ...data });
      this.lastSkipReason = reason;
      this.lastSkipLoggedAt = now;
    }
  }

  private async tick(): Promise<void> {
    this.tickCount++;
    if (this.inFlight) {
      this.noteSkip("previous tick still in flight");
      return;
    }
    if (!this.autoRun.isEnabled) {
      this.stop();
      return;
    }

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const requireFocus = cfg.get<boolean>("autoRun.requireWindowFocus", true);
    if (requireFocus && !vscode.window.state.focused) {
      this.noteSkip("VS Code window not focused");
      return;
    }

    const recentMs = cfg.get<number>("affectedChats.recentActivityMs", 60000);
    if (!this.affected.hasRecentAllowedActivity(recentMs)) {
      this.noteSkip("no allow-listed chat sessions", { allowedCount: this.affected.listAllowedIds().length });
      return;
    }

    // Reset the suppressor when we actually fire.
    this.lastSkipReason = null;
    this.inFlight = true;
    try {
      const allowResult = await this.autoClicker.pressAllow({ silent: true });
      const keepResult = await this.autoClicker.pressKeep({ silent: true });
      this.firedCount++;
      // Only log when at least one strategy did something useful.
      if (allowResult.ok || keepResult.ok) {
        this.activity.add("APPROVE", `Tick #${this.tickCount} fired (Allow: ${allowResult.via}, Keep: ${keepResult.via})`, {
          tickCount: this.tickCount,
          firedCount: this.firedCount,
          allow: allowResult,
          keep: keepResult,
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  public dispose(): void {
    this.stop();
  }
}

import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";
import type { AutoRunMode } from "./AutoRunMode";
import type { AutoClicker } from "./AutoClicker";
import type { AffectedChats } from "./AffectedChats";

/**
 * Drives the silent "press Allow + press Keep" loop while Auto-Run is on.
 * Polls every `lakeburner.autoRun.tickIntervalMs` (default 0; opt-in only).
 *
 * Guards (all must pass for a tick to fire):
 *   - Auto-Run is ON
 *   - tickIntervalMs > 0
 *   - VS Code window is focused (when requireWindowFocus = true)
 *   - At least one allow-listed chat session has been active within
 *     `affectedChats.recentActivityMs` (default 60s). If the allowlist is
 *     empty the ticker is effectively disabled — you must opt-in per chat.
 */
export class AutoRunTicker implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly autoRun: AutoRunMode,
    private readonly autoClicker: AutoClicker,
    private readonly affected: AffectedChats
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
      this.logger.info({ fn: "refresh" }, "Auto-Run Ticker Disabled (interval <= 0)");
      return;
    }

    this.logger.task({ fn: "refresh" }, "Auto-Run Ticker Started", { intervalMs: interval });
    this.timer = setInterval(() => void this.tick(), interval);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info({ fn: "stop" }, "Auto-Run Ticker Stopped");
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    if (!this.autoRun.isEnabled) {
      this.stop();
      return;
    }

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const requireFocus = cfg.get<boolean>("autoRun.requireWindowFocus", true);
    if (requireFocus && !vscode.window.state.focused) return;

    const recentMs = cfg.get<number>("affectedChats.recentActivityMs", 60000);
    if (!this.affected.hasRecentAllowedActivity(recentMs)) return;

    this.inFlight = true;
    try {
      await this.autoClicker.pressAllow({ silent: true });
      await this.autoClicker.pressKeep({ silent: true });
    } finally {
      this.inFlight = false;
    }
  }

  public dispose(): void {
    this.stop();
  }
}

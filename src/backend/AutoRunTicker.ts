import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";
import type { AutoRunMode } from "./AutoRunMode";
import type { AutoClicker } from "./AutoClicker";
import type { AffectedChats } from "./AffectedChats";
import type { ActivityLog } from "./ActivityLog";
import type { PromptDispatcher } from "./PromptDispatcher";

/**
 * Drives the silent "press Allow + press Keep" loop while Auto-Run is on,
 * and dispatches a "Keep going" continue-prompt when the conversation has
 * stalled (no Allow/Keep button has been pressed for a configurable idle
 * window). Polls every `lakeburner.autoRun.tickIntervalMs`.
 */
export class AutoRunTicker implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastSkipReason: string | null = null;
  private lastSkipLoggedAt = 0;
  private tickCount = 0;
  private firedCount = 0;
  /** Wall-clock ms when the timer most recently started or fired a real action. */
  private lastFireAt = Date.now();
  /** Wall-clock ms of the most recent keep-going dispatch (used to enforce cooldown). */
  private lastKeepGoingAt = 0;
  /** Wall-clock ms when the chat busy indicator (Stop/Cancel) was last seen.
   *  We start at `Date.now()` so the very first poll waits a full cooldown
   *  before considering Keep Going — we cannot prove the chat is idle on
   *  tick #1, only that we haven't seen it busy yet. */
  private lastBusyAt = Date.now();
  /** Number of consecutive ticks where the busy probe returned no match. */
  private idleStreak = 0;

  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly autoRun: AutoRunMode,
    private readonly autoClicker: AutoClicker,
    private readonly affected: AffectedChats,
    private readonly activity: ActivityLog,
    private readonly dispatcher: PromptDispatcher
  ) {}

  public start(context: vscode.ExtensionContext): void {
    this.refresh();
    context.subscriptions.push(this.autoRun.onChange(() => this.refresh()));
    // Refresh whenever Active Fires change. The timer only runs while at
    // least one chat is active.
    context.subscriptions.push(this.affected.onChange(() => this.refresh()));
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${this.cfgSection}.autoRun.tickIntervalMs`)) this.refresh();
      })
    );
    context.subscriptions.push(this);
  }

  private refresh(): void {
    const wantTimer = this.shouldRun();
    if (!wantTimer) {
      this.stop();
      return;
    }
    if (this.timer) return; // already running with the right config

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const interval = cfg.get<number>("autoRun.tickIntervalMs", 0);
    this.activity.add(
      "INFO",
      `Ticker started @ every ${interval}ms (active fires: ${this.affected.listActiveIds().length})`,
      { intervalMs: interval, activeFireCount: this.affected.listActiveIds().length }
    );
    this.logger.task({ fn: "refresh" }, "Auto-Run Ticker Started", { intervalMs: interval });
    // Reset the stall clock — we don't want a "Keep going" to fire the moment
    // the timer starts because of a stale lastFireAt from a previous arming.
    this.lastFireAt = Date.now();
    this.lastKeepGoingAt = 0;
    this.lastBusyAt = Date.now();
    this.idleStreak = 0;
    this.timer = setInterval(() => void this.tick(), interval);
  }

  /**
   * The ticker should only have a live timer when ALL of the following hold:
   *   - Auto-Run is ON
   *   - tickIntervalMs > 0
   *   - At least one Active Fire exists
   *
   * The window-focus guard is intentionally NOT checked here — focus changes
   * are too frequent to start/stop the timer on, so we honor it inside tick()
   * with a quiet skip.
   */
  private shouldRun(): boolean {
    if (!this.autoRun.isEnabled) return false;
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const interval = cfg.get<number>("autoRun.tickIntervalMs", 0);
    if (!Number.isFinite(interval) || interval <= 0) return false;
    if (!this.affected.hasActiveFires()) return false;
    return true;
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.activity.add("INFO", "Ticker stopped (no active fires, Auto-Run off, or interval=0)");
      this.logger.info({ fn: "stop" }, "Auto-Run Ticker Stopped");
    }
  }

  /** Log a skip reason at most once per 30s, or whenever the reason changes. */
  private noteSkip(reason: string, data?: Record<string, unknown>): void {
    const now = Date.now();
    if (reason !== this.lastSkipReason || now - this.lastSkipLoggedAt > 30000) {
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
    // Re-check the start guard cheaply — handles the race where Auto-Run was
    // turned off or Active Fires were cleared between intervals.
    if (!this.shouldRun()) {
      this.stop();
      return;
    }

    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const requireFocus = cfg.get<boolean>("autoRun.requireWindowFocus", false);
    if (requireFocus && !vscode.window.state.focused) {
      this.noteSkip("VS Code window not focused");
      return;
    }

    // Reset the suppressor when we actually fire.
    this.lastSkipReason = null;
    this.inFlight = true;
    try {
      // Redundancy pass: if the chat composer is currently exposing
      // "Remove All Queued" (because something slipped past the busy
      // probe), wipe it before doing anything else. Silent by design —
      // the option is absent on every normal tick, which is fine.
      if (cfg.get<boolean>("autoRun.clearQueuedEnabled", true)) {
        const cleared = await this.autoClicker.uia.pressRemoveAllQueued({ silent: true });
        if (cleared) {
          // A queued item proves the chat was busy at some point in the
          // recent past — reset the busy clock so we do not immediately
          // fire another Keep Going on top of whatever the chat does next.
          this.lastBusyAt = Date.now();
          this.idleStreak = 0;
          this.activity.add(
            "APPROVE",
            `Cleared queued prompts via "${cleared}"`,
            { strategy: "uia", intent: "removeQueued", name: cleared }
          );
        }
      }

      // UIA-only in the ticker: command + coordinate strategies steal focus
      // (chat panel activation) or jump the mouse cursor. UIA Invoke() does
      // neither — it presses the button in-place without raising the window.
      const allowResult = await this.autoClicker.pressAllow({ silent: true, uiaOnly: true });
      const keepResult = await this.autoClicker.pressKeep({ silent: true, uiaOnly: true });
      this.firedCount++;
      // Only log when at least one strategy did something useful.
      if (allowResult.ok || keepResult.ok) {
        this.lastFireAt = Date.now();
        // A successful Allow/Keep press means the chat just resumed work
        // (we approved a tool call or kept an edit). The busy indicator
        // will appear momentarily but the probe may miss it on the next
        // tick due to timing — so treat this press as proof of activity
        // and reset the busy clock. Without this, the idle countdown
        // accumulates straight through tool approvals.
        this.lastBusyAt = Date.now();
        this.idleStreak = 0;
        this.activity.add("APPROVE", `Tick #${this.tickCount} fired (Allow: ${allowResult.via}, Keep: ${keepResult.via})`, {
          tickCount: this.tickCount,
          firedCount: this.firedCount,
          allow: allowResult,
          keep: keepResult,
        });
      } else {
        // Nothing pressed this tick — the conversation may have stalled.
        await this.maybeSendKeepGoing(cfg);
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Dispatch the configured "Keep going" prompt only when the chat is
   * provably idle: the UIA busy probe must have returned NO Stop/Cancel
   * button for at least `autoRun.keepGoingAfterIdleMs`, AND for at least
   * `autoRun.keepGoingIdleStreak` consecutive ticks. We never queue — if
   * the assistant is still generating, we wait, no matter how long.
   *
   * The previous "time since last APPROVE" trigger was removed entirely:
   * a long-running generation that never needs an Allow/Keep press should
   * never be interrupted with a Keep Going.
   */
  private async maybeSendKeepGoing(cfg: vscode.WorkspaceConfiguration): Promise<void> {
    if (!this.shouldRun()) return;

    const singletEnabled = cfg.get<boolean>("singletMode.enabled", false);
    const keepGoingEnabled = cfg.get<boolean>("autoRun.keepGoingEnabled", true);

    // Need idle detection for either singlet mode or keep going.
    if (!keepGoingEnabled && !singletEnabled) return;

    const idleMs = cfg.get<number>("autoRun.keepGoingAfterIdleMs", 15000);
    if (!Number.isFinite(idleMs) || idleMs <= 0) return;

    const now = Date.now();
    const sinceLastSend = now - this.lastKeepGoingAt;

    // Cooldown: never re-send within the idle window. Prevents a rapid
    // re-fire after the assistant briefly acknowledges and then stops.
    // Singlet mode skips this — it terminates rather than re-sends.
    if (!singletEnabled && sinceLastSend < idleMs) return;

    // Probe FIRST. We only send when this returns null AND has been null
    // for the full quiet period. Whatever happened before the probe (an
    // APPROVE press, a long thinking pause, etc.) is irrelevant.
    const busy = await this.autoClicker.uia.findBusyIndicator({ silent: true });
    if (busy) {
      this.lastBusyAt = now;
      this.idleStreak = 0;
      this.activity.add(
        "INFO",
        `Tick #${this.tickCount} probe: busy ("${busy}") — chat still generating, holding`,
        { tickCount: this.tickCount, busy }
      );
      return;
    }

    const quietFor = now - this.lastBusyAt;
    if (quietFor < idleMs) {
      this.activity.add(
        "INFO",
        `Tick #${this.tickCount} probe: idle — countdown ${Math.round(quietFor / 1000)}s / ${Math.round(idleMs / 1000)}s before Keep Going`,
        { tickCount: this.tickCount, remainingMs: idleMs - quietFor, idleMs, quietFor }
      );
      return;
    }

    // Quiet long enough — require N consecutive idle ticks to confirm.
    this.idleStreak++;
    const required = Math.max(1, cfg.get<number>("autoRun.keepGoingIdleStreak", 3));
    if (this.idleStreak < required) {
      this.activity.add(
        "INFO",
        `Idle confirmation ${this.idleStreak}/${required} (${Math.round(quietFor / 1000)}s since last Stop button)`,
        { idleStreak: this.idleStreak, required, quietFor }
      );
      return;
    }

    // Singlet Mode: end the session instead of nudging.
    if (singletEnabled) {
      const quietForFinal = now - this.lastBusyAt;
      this.idleStreak = 0;
      this.activity.add(
        "INFO",
        `Singlet Mode: task completed — ending session (${Math.round(quietForFinal / 1000)}s idle, no nudge-prompt sent)`,
        { quietForMs: quietForFinal, idleStreak: required }
      );
      await this.autoRun.setEnabled(false);
      await this.affected.clear();
      return;
    }

    // Normal keep going: if disabled, nothing more to do.
    if (!keepGoingEnabled) return;

    const text = (cfg.get<string>("autoRun.keepGoingPrompt", "") || "").trim()
      || "Keep going. I trust your intuitions.\n\nIf the task is complete, find ways to improve what we've done in either quantity or quality. Our goal is endless generation with asymtotal diminishing returns. This verifies we reach a state where 'there is no more to be added' and 'the data quality cannot reliably through a variety of sources contemporary to the current year as it is in a state of maximum trustoworthiness'";
    const targetId = this.affected.getActiveTargetId() || "copilot";

    if (!this.shouldRun()) return;

    // Final guard: re-probe immediately before dispatch. The earlier probe
    // is N ticks old and the chat may have entered a new busy phase since.
    // We must NEVER queue on top of an active generation — a queued prompt
    // is worse than a missed one because it overrides whatever the user
    // would have typed next.
    const finalBusy = await this.autoClicker.uia.findBusyIndicator({ silent: true });
    if (finalBusy) {
      this.lastBusyAt = Date.now();
      this.idleStreak = 0;
      this.activity.add(
        "INFO",
        `Aborting Keep Going dispatch — ${finalBusy} re-appeared in final-guard probe`,
        { finalBusy }
      );
      return;
    }

    this.lastKeepGoingAt = now;
    this.idleStreak = 0;
    const quietForFinal = now - this.lastBusyAt;
    this.activity.add("REQUEST", `Idle confirmed (${Math.round(quietForFinal / 1000)}s since last Stop button, ${required} confirmation ticks) → sending Keep Going to ${targetId}`, {
      quietForMs: quietForFinal,
      targetId,
      promptLength: text.length,
      idleStreak: required,
    });
    try {
      const result = await this.dispatcher.send(targetId, text);
      // Treat the dispatch itself as activity, so we don't immediately fire
      // another Keep Going on the very next tick. Also reset the busy clock
      // so the cooldown countdown begins from now.
      this.lastFireAt = Date.now();
      this.lastBusyAt = Date.now();
      if (!result.ok) {
        // For uia-compose, a non-ok result usually means "composer not
        // realized yet" (e.g. chat panel hidden) — not a real failure.
        // Allow retry on the next tick by NOT advancing lastKeepGoingAt past
        // the cooldown: rewind it so the next idle window can fire.
        if (result.via === "uia-compose") {
          this.lastKeepGoingAt = 0;
          this.activity.add("INFO", `Keep Going via ${result.via} skipped: ${result.reason ?? "unknown"} — will retry`, { result });
        } else {
          this.activity.add("BLOCK", `Keep Going dispatch failed: ${result.reason ?? "unknown"}`, { result });
        }
      } else {
        this.activity.add("INFO", `Keep Going dispatched via ${result.via}`, { via: result.via, targetId });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.activity.add("BLOCK", `Keep Going dispatch threw: ${reason}`);
    }
  }

  public dispose(): void {
    this.stop();
  }
}

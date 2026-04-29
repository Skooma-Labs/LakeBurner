import * as vscode from "vscode";
import * as crypto from "crypto";
import type { Logger } from "../frontend/ts/TSLogger";

const STATE_KEY = "lakeburner.affectedChats.v1";
const ALLOWLIST_KEY = "lakeburner.affectedChats.allowlist.v1";
const ARM_KEY = "lakeburner.affectedChats.armUntil.v1";

export type ChatSessionRecord = {
  /** Stable ID derived from the first user prompt in the conversation. */
  id: string;
  /** Short human label (first ~60 chars of the first prompt). */
  label: string;
  /** ISO timestamp the session was first registered. */
  firstSeenIso: string;
  /** ISO timestamp of the most recent @lakeburner invocation in this session. */
  lastSeenIso: string;
  /** Number of @lakeburner turns observed. */
  turns: number;
};

/**
 * AffectedChats — registry of chat sessions where @lakeburner has been invoked,
 * plus a user-controlled allowlist that gates which sessions Auto-Run may
 * affect via OS-level approval clicks.
 *
 * Stable session IDs are derived by hashing the conversation's first user
 * prompt (taken from `ChatContext.history` or `request.prompt` on the very
 * first turn). VS Code's stable chat API does not expose a real session ID,
 * so this fingerprint is the most reliable handle we can build.
 *
 * Sessions older than `lakeburner.affectedChats.windowDays` (default 3 days)
 * are pruned on every read.
 */
export class AffectedChats {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cfgSection: string,
    private readonly logger: Logger
  ) {}

  /** Compute a stable session ID for the current chat turn. */
  public static fingerprint(firstPrompt: string): string {
    const normalized = (firstPrompt ?? "").trim().slice(0, 4000);
    return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Register (or bump) a session and return its ID. Called from the chat
   * participant on every @lakeburner turn.
   */
  public registerTurn(firstPrompt: string, currentPrompt: string): string {
    const id = AffectedChats.fingerprint(firstPrompt || currentPrompt);
    const now = new Date().toISOString();
    const all = this.readAll();
    const existing = all[id];
    if (existing) {
      existing.lastSeenIso = now;
      existing.turns += 1;
    } else {
      all[id] = {
        id,
        label: shortLabel(firstPrompt || currentPrompt),
        firstSeenIso: now,
        lastSeenIso: now,
        turns: 1,
      };
      this.logger.task({ fn: "registerTurn" }, "New Chat Session Tracked", { id, label: all[id].label });
      if (this.getAutoAllow()) {
        const set = new Set(this.listAllowedIds());
        if (!set.has(id)) {
          set.add(id);
          void this.context.globalState.update(ALLOWLIST_KEY, Array.from(set));
          this.logger.user({ fn: "registerTurn" }, "Auto-Allowlisted New Session", { id });
        }
      }
    }
    void this.context.globalState.update(STATE_KEY, all);
    this.emitter.fire();
    return id;
  }

  /** Sessions within the configured window, newest-first. */
  public list(): ChatSessionRecord[] {
    const windowDays = this.getWindowDays();
    const cutoff = Date.now() - windowDays * 86400000;
    const all = this.readAll();
    const kept: Record<string, ChatSessionRecord> = {};
    const out: ChatSessionRecord[] = [];
    for (const r of Object.values(all)) {
      const t = Date.parse(r.lastSeenIso);
      if (Number.isFinite(t) && t >= cutoff) {
        kept[r.id] = r;
        out.push(r);
      }
    }
    if (Object.keys(kept).length !== Object.keys(all).length) {
      void this.context.globalState.update(STATE_KEY, kept);
    }
    return out.sort((a, b) => Date.parse(b.lastSeenIso) - Date.parse(a.lastSeenIso));
  }

  public listAllowedIds(): string[] {
    const raw = this.context.globalState.get<string[]>(ALLOWLIST_KEY, []);
    return Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
  }

  public isAllowed(id: string): boolean {
    return this.listAllowedIds().includes(id);
  }

  public async setAllowed(id: string, allowed: boolean): Promise<void> {
    const set = new Set(this.listAllowedIds());
    if (allowed) set.add(id);
    else set.delete(id);
    await this.context.globalState.update(ALLOWLIST_KEY, Array.from(set));
    this.logger.user({ fn: "setAllowed" }, "Allowlist Updated", { id, allowed });
    this.emitter.fire();
  }

  /**
   * Wipe the entire registry (sessions + allowlist + legacy arm key). Called
   * on extension activation so each LakeBurner session starts from a clean
   * slate — no chats are armed until the user explicitly arms one via Send
   * Initial Prompt or `@lakeburner start`.
   */
  public async clearAll(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, undefined);
    await this.context.globalState.update(ALLOWLIST_KEY, undefined);
    await this.context.globalState.update(ARM_KEY, undefined);
    this.logger.task({ fn: "clearAll" }, "Affected Chats Reset");
    this.emitter.fire();
  }

  /**
   * Auto-Run gate: true if any allow-listed session exists (and is still in
   * the tracking window). Membership is the only signal — once a session is
   * on the list, it stays armed for that window until it's explicitly removed
   * via `@lakeburner stop`, the Clear button, or natural pruning.
   */
  public hasRecentAllowedActivity(_recentMs: number): boolean {
    const allowed = new Set(this.listAllowedIds());
    if (allowed.size === 0) return false;
    for (const r of this.list()) {
      if (allowed.has(r.id)) return true;
    }
    return false;
  }

  /**
   * Register a session derived from a known prompt (used by Send Initial
   * Prompt — the chat participant doesn't run for those, so we register on
   * the dispatcher side using the prompt as the fingerprint seed). The
   * resulting session ID will collide with the one the chat participant
   * would compute if/when @lakeburner is later invoked in the same
   * conversation, because both seed off the conversation's first user prompt.
   */
  public async registerExternal(promptText: string, label?: string): Promise<string> {
    const id = AffectedChats.fingerprint(promptText);
    const now = new Date().toISOString();
    const all = this.readAll();
    if (all[id]) {
      all[id].lastSeenIso = now;
      all[id].turns += 1;
    } else {
      all[id] = {
        id,
        label: shortLabel(label ?? promptText),
        firstSeenIso: now,
        lastSeenIso: now,
        turns: 1,
      };
      this.logger.task({ fn: "registerExternal" }, "External Chat Session Tracked", { id, label: all[id].label });
    }
    await this.context.globalState.update(STATE_KEY, all);
    const set = new Set(this.listAllowedIds());
    if (!set.has(id)) {
      set.add(id);
      await this.context.globalState.update(ALLOWLIST_KEY, Array.from(set));
      this.logger.user({ fn: "registerExternal" }, "Allowlisted External Session", { id });
    }
    this.emitter.fire();
    return id;
  }

  /** Remove a session entirely — used by @lakeburner stop. */
  public async removeSession(id: string): Promise<void> {
    const all = this.readAll();
    if (all[id]) {
      delete all[id];
      await this.context.globalState.update(STATE_KEY, all);
    }
    const set = new Set(this.listAllowedIds());
    if (set.has(id)) {
      set.delete(id);
      await this.context.globalState.update(ALLOWLIST_KEY, Array.from(set));
    }
    this.logger.user({ fn: "removeSession" }, "Session Removed", { id });
    this.emitter.fire();
  }

  /**
   * Manual arm: kept for back-compat callers but no longer used by the
   * default Auto-Run flow. Allowlist membership is the gate now.
   */
  public async arm(durationMs: number, reason: string): Promise<void> {
    const until = Date.now() + Math.max(0, durationMs);
    await this.context.globalState.update(ARM_KEY, until);
    this.logger.user({ fn: "arm" }, "Auto-Run Manually Armed (legacy)", { durationMs, reason });
    this.emitter.fire();
  }

  public async disarm(reason: string): Promise<void> {
    await this.context.globalState.update(ARM_KEY, 0);
    this.logger.user({ fn: "disarm" }, "Auto-Run Manually Disarmed", { reason });
    this.emitter.fire();
  }

  public isManuallyArmed(): boolean {
    const until = this.context.globalState.get<number>(ARM_KEY, 0);
    return typeof until === "number" && until > Date.now();
  }

  public armedUntilIso(): string | null {
    const until = this.context.globalState.get<number>(ARM_KEY, 0);
    if (!until || until <= Date.now()) return null;
    return new Date(until).toISOString();
  }

  public async clear(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, {});
    await this.context.globalState.update(ALLOWLIST_KEY, []);
    await this.context.globalState.update(ARM_KEY, 0);
    this.logger.user({ fn: "clear" }, "Affected Chats Cleared");
    this.emitter.fire();
  }

  private readAll(): Record<string, ChatSessionRecord> {
    const raw = this.context.globalState.get<Record<string, ChatSessionRecord>>(STATE_KEY, {});
    return raw && typeof raw === "object" ? raw : {};
  }

  private getWindowDays(): number {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const v = cfg.get<number>("affectedChats.windowDays", 3);
    return Number.isFinite(v) && v > 0 ? v : 3;
  }

  private getAutoAllow(): boolean {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    return cfg.get<boolean>("affectedChats.autoAllowNewSessions", true);
  }
}

function shortLabel(s: string): string {
  const trimmed = (s ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length <= 60) return trimmed || "(empty prompt)";
  return trimmed.slice(0, 57) + "…";
}

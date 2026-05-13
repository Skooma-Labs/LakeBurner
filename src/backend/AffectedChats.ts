import * as vscode from "vscode";
import * as crypto from "crypto";
import type { Logger } from "../frontend/ts/Logger";

const STATE_KEY = "lakeburner.affectedChats.v1";
const LEGACY_ALLOWLIST_KEY = "lakeburner.affectedChats.allowlist.v1";
const LEGACY_ARM_KEY = "lakeburner.affectedChats.armUntil.v1";
const TARGET_KEY = "lakeburner.affectedChats.activeTargetId.v1";

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
 * Active Fires registry. A chat is either active or it is not; there is no
 * separate history window or user-controlled allowlist.
 *
 * Stable session IDs are derived by hashing the conversation's first user
 * prompt (taken from `ChatContext.history` or `request.prompt` on the very
 * first turn). VS Code's stable chat API does not expose a real session ID,
 * so this fingerprint is the most reliable handle we can build.
 */
export class AffectedChats {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onChange = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {}

  /** Compute a stable session ID for the current chat turn. */
  public static fingerprint(firstPrompt: string): string {
    const normalized = (firstPrompt ?? "").trim().slice(0, 4000);
    return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  }

  /**
   * Return the stable ID for a turn and bump the record only if it is already
   * an Active Fire. This lets non-start @lakeburner commands carry session
   * metadata without turning ordinary participant usage into a fire.
   */
  public async noteTurn(firstPrompt: string, currentPrompt: string): Promise<string> {
    const id = AffectedChats.fingerprint(firstPrompt || currentPrompt);
    const all = this.readAll();
    const existing = all[id];
    if (!existing) return id;

    existing.lastSeenIso = new Date().toISOString();
    existing.turns += 1;
    await this.context.globalState.update(STATE_KEY, all);
    this.emitter.fire();
    return id;
  }

  /**
   * Register (or bump) an Active Fire and return its ID. Called from the chat
   * participant start command and Start a Chat flows.
   */
  public async registerTurn(firstPrompt: string, currentPrompt: string): Promise<string> {
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
      this.logger.task({ fn: "registerTurn" }, "New Active Fire Tracked", { id, label: all[id].label });
    }
    await this.context.globalState.update(STATE_KEY, all);
    this.emitter.fire();
    return id;
  }

  /**
   * Register the current chat turn and make it active for Auto-Run in one
   * awaited operation. Used by `@lakeburner start` so an existing chat is
   * promoted to Active Fires with the same reliability as Start a Chat.
   */
  public async igniteTurn(firstPrompt: string, currentPrompt: string): Promise<string> {
    return await this.registerTurn(firstPrompt, currentPrompt);
  }

  /** Active Fires, newest-first. */
  public list(): ChatSessionRecord[] {
    return Object.values(this.readAll()).sort((a, b) => Date.parse(b.lastSeenIso) - Date.parse(a.lastSeenIso));
  }

  public listActiveIds(): string[] {
    return this.list().map((r) => r.id);
  }

  public hasActiveFires(): boolean {
    return this.listActiveIds().length > 0;
  }

  /**
   * Wipe the entire registry. Called on extension activation so each
   * LakeBurner session starts from a clean slate: no chats are active until
   * the user explicitly starts one via Send Initial Prompt or
   * `@lakeburner start`.
   */
  public async clearAll(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, undefined);
    await this.context.globalState.update(LEGACY_ALLOWLIST_KEY, undefined);
    await this.context.globalState.update(LEGACY_ARM_KEY, undefined);
    await this.context.globalState.update(TARGET_KEY, undefined);
    this.logger.task({ fn: "clearAll" }, "Active Fires Reset");
    this.emitter.fire();
  }

  /**
   * Register a session derived from a known prompt (used by Send Initial
   * Prompt; the chat participant does not run for those, so we register on
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
      this.logger.task({ fn: "registerExternal" }, "External Active Fire Tracked", { id, label: all[id].label });
    }
    await this.context.globalState.update(STATE_KEY, all);
    this.emitter.fire();
    return id;
  }

  /** Remove a single Active Fire. */
  public async removeSession(id: string): Promise<void> {
    const all = this.readAll();
    if (all[id]) {
      delete all[id];
      await this.context.globalState.update(STATE_KEY, all);
    }
    await this.removeLegacyAllowedId(id);
    this.logger.user({ fn: "removeSession" }, "Active Fire Removed", { id });
    this.emitter.fire();
  }

  public async clear(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, {});
    await this.context.globalState.update(LEGACY_ALLOWLIST_KEY, []);
    await this.context.globalState.update(LEGACY_ARM_KEY, 0);
    await this.context.globalState.update(TARGET_KEY, undefined);
    this.logger.user({ fn: "clear" }, "Active Fires Cleared");
    this.emitter.fire();
  }

  private readAll(): Record<string, ChatSessionRecord> {
    const raw = this.context.globalState.get<Record<string, ChatSessionRecord>>(STATE_KEY, {});
    return raw && typeof raw === "object" ? raw : {};
  }

  private async removeLegacyAllowedId(id: string): Promise<void> {
    const raw = this.context.globalState.get<string[]>(LEGACY_ALLOWLIST_KEY, []);
    if (!Array.isArray(raw) || !raw.includes(id)) return;
    await this.context.globalState.update(LEGACY_ALLOWLIST_KEY, raw.filter((v) => v !== id));
  }

  /** The prompt-target selected in "Start a Chat". The Keep Going ticker
   * reads this instead of a setting so the nudge always goes to the same
   * overlord the user picked in the sidebar. */
  public getActiveTargetId(): string | undefined {
    return this.context.globalState.get<string>(TARGET_KEY);
  }

  public async setActiveTargetId(targetId: string): Promise<void> {
    await this.context.globalState.update(TARGET_KEY, targetId);
    this.logger.task({ fn: "setActiveTargetId" }, "Active Target Updated", { targetId });
  }
}

function shortLabel(s: string): string {
  const trimmed = (s ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length <= 60) return trimmed || "(empty prompt)";
  return trimmed.slice(0, 57) + "...";
}

import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";
import type { ActivityLog } from "./ActivityLog";

export type DispatchMode = "string" | "object-query" | "clipboard";

export type PromptTarget = {
  id: string;
  label: string;
  command: string;
  mode: DispatchMode;
  /**
   * For mode=object-query: extra static fields merged into the command argument
   * (e.g. `{ mode: "agent" }` for Copilot Chat agent mode).
   */
  extraArgs?: Record<string, unknown>;
};

export type DispatchResult = {
  ok: boolean;
  via: DispatchMode;
  target: PromptTarget;
  reason?: string;
};

const DEFAULT_TARGETS: PromptTarget[] = [
  {
    id: "copilot",
    label: "GitHub Copilot Chat",
    command: "workbench.action.chat.open",
    mode: "object-query",
  },
  {
    id: "copilot-agent",
    label: "GitHub Copilot Chat (Agent)",
    command: "workbench.action.chat.open",
    mode: "object-query",
    extraArgs: { mode: "agent" },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude-vscode.newConversation",
    mode: "clipboard",
  },
  {
    id: "codex",
    label: "OpenAI Codex / ChatGPT",
    command: "chatgpt.newChat",
    mode: "clipboard",
  },
];

export class PromptDispatcher {
  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly activity: ActivityLog
  ) {}

  public listTargets(): PromptTarget[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("initialPrompt.targets");

    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TARGETS;

    const out: PromptTarget[] = [];
    for (const item of raw) {
      const t = this.parseTarget(item);
      if (t) out.push(t);
    }
    return out.length > 0 ? out : DEFAULT_TARGETS;
  }

  public getDefaultPrompt(): string {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const v = cfg.get<unknown>("initialPrompt.default");
    return typeof v === "string" ? v : "";
  }

  public async setDefaultPrompt(prompt: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    await cfg.update("initialPrompt.default", prompt, vscode.ConfigurationTarget.Global);
    this.logger.user({ fn: "setDefaultPrompt" }, "Default Initial Prompt Updated", { length: prompt.length });
  }

  public async send(targetId: string, prompt: string): Promise<DispatchResult> {
    const target = this.listTargets().find((t) => t.id === targetId);
    if (!target) {
      const reason = `Unknown target: ${targetId}`;
      this.logger.warn({ fn: "send" }, reason);
      return { ok: false, via: "string", target: { id: targetId, label: targetId, command: "", mode: "string" }, reason };
    }

    const trimmed = prompt.trim();
    if (!trimmed) {
      const reason = "Prompt is empty";
      this.logger.warn({ fn: "send" }, reason, { target: target.id });
      return { ok: false, via: target.mode, target, reason };
    }

    this.logger.user({ fn: "send" }, "Sending Initial Prompt", {
      target: target.id,
      command: target.command,
      mode: target.mode,
      length: trimmed.length,
    });
    this.activity.add("REQUEST", `Initial prompt → ${target.label}`, {
      command: target.command,
      mode: target.mode,
      length: trimmed.length,
    });

    try {
      switch (target.mode) {
        case "string":
          await vscode.commands.executeCommand(target.command, trimmed);
          break;

        case "object-query": {
          const arg = { query: trimmed, ...(target.extraArgs ?? {}) };
          await vscode.commands.executeCommand(target.command, arg);
          break;
        }

        case "clipboard": {
          await vscode.env.clipboard.writeText(trimmed);
          await vscode.commands.executeCommand(target.command);
          vscode.window.showInformationMessage(
            `LakeBurner: prompt copied to clipboard. Paste it into ${target.label} with Ctrl+V.`
          );
          break;
        }
      }

      this.activity.add("APPROVE", `Prompt dispatched to ${target.label}`, { mode: target.mode });
      return { ok: true, via: target.mode, target };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ fn: "send" }, "Dispatch Failed", { target: target.id, command: target.command, reason });
      this.activity.add("BLOCK", `Dispatch failed for ${target.label}: ${reason}`);

      // Last-ditch fallback: copy to clipboard so the user can paste manually.
      try {
        await vscode.env.clipboard.writeText(trimmed);
        vscode.window.showWarningMessage(
          `LakeBurner: ${target.label} command failed (${reason}). Prompt was copied to your clipboard.`
        );
      } catch {
        // ignore
      }

      return { ok: false, via: target.mode, target, reason };
    }
  }

  private parseTarget(raw: unknown): PromptTarget | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;

    const id = typeof r.id === "string" ? r.id.trim() : "";
    const command = typeof r.command === "string" ? r.command.trim() : "";
    const mode = r.mode === "string" || r.mode === "object-query" || r.mode === "clipboard" ? r.mode : "object-query";
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id;
    const extraArgs = r.extraArgs && typeof r.extraArgs === "object" ? (r.extraArgs as Record<string, unknown>) : undefined;

    if (!id || !command) return null;
    return { id, label, command, mode, extraArgs };
  }
}

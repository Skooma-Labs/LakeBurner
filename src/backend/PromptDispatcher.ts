import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";
import type { ActivityLog } from "./ActivityLog";
import type { UIAAutoClicker } from "./UIAAutoClicker";

export type DispatchMode = "string" | "object-query" | "clipboard" | "codex-deeplink" | "uia-compose";

export type PromptTarget = {
  id: string;
  label: string;
  command: string;
  mode: DispatchMode;
  /**
   * For mode=object-query: extra static fields merged into the command argument
   * (e.g. `{ mode: "agent" }` for Copilot Chat agent mode).
   * For mode=codex-deeplink: optional `{ path, originUrl, includeWorkspacePath, fallbackCommand }`.
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
    label: "GitHub Copilot",
    command: "workbench.action.chat.open",
    mode: "uia-compose",
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
    label: "OpenAI Codex",
    command: "codex://new",
    mode: "codex-deeplink",
  },
];

export class PromptDispatcher {
  constructor(
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly activity: ActivityLog,
    private readonly uia: UIAAutoClicker
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
          await this.copyToClipboardAndOpen(target, trimmed);
          break;
        }

        case "codex-deeplink": {
          const opened = await this.openCodexDeeplink(target, trimmed);
          if (!opened) {
            this.activity.add("INFO", `Codex deeplink was not accepted; falling back to clipboard for ${target.label}`, {
              mode: target.mode,
            });
            await this.copyToClipboardAndOpen(target, trimmed);
          }
          break;
        }

        case "uia-compose": {
          // Pure background path: type into the chat composer via UIA
          // ValuePattern, invoke Send via UIA InvokePattern. No focus theft,
          // no cursor movement. We intentionally do NOT fall back to
          // executeCommand on miss — that would re-introduce the
          // foreground/cursor bug this mode exists to prevent. The caller
          // (Auto-Run ticker) retries on the next tick.
          const restoreCfg = vscode.workspace
            .getConfiguration(this.cfgSection)
            .get<boolean>("uia.restoreMinimizedForNudge", true);
          const result = await this.uia.composeAndSend(trimmed, {
            silent: false,
            restoreIfMinimized: restoreCfg,
          });
          if (!result.ok) {
            const reason = result.reason ?? "unknown";
            this.logger.info({ fn: "send" }, "UIA Compose Skipped", { target: target.id, reason });
            this.activity.add("INFO", `UIA compose skipped for ${target.label}: ${reason} — will retry next tick`, {
              mode: target.mode,
              reason,
            });
            return { ok: false, via: target.mode, target, reason };
          }
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
    const mode = this.isDispatchMode(r.mode) ? r.mode : "object-query";
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim() : id;
    const extraArgs = r.extraArgs && typeof r.extraArgs === "object" ? (r.extraArgs as Record<string, unknown>) : undefined;

    if (!id || !command) return null;
    return { id, label, command, mode, extraArgs };
  }

  private async copyToClipboardAndOpen(target: PromptTarget, prompt: string): Promise<void> {
    await vscode.env.clipboard.writeText(prompt);

    const fallbackCommand =
      this.getStringExtra(target, "fallbackCommand") ?? (target.mode === "codex-deeplink" ? "chatgpt.newChat" : target.command);
    if (fallbackCommand) await vscode.commands.executeCommand(fallbackCommand);

    vscode.window.showInformationMessage(
      `LakeBurner: prompt copied to clipboard. Paste it into ${target.label} with Ctrl+V.`
    );
  }

  private async openCodexDeeplink(target: PromptTarget, prompt: string): Promise<boolean> {
    const query = new URLSearchParams();
    query.set("prompt", prompt);

    const includeWorkspacePath = this.getBooleanExtra(target, "includeWorkspacePath") !== false;
    const path = this.getStringExtra(target, "path") ?? (includeWorkspacePath ? this.getWorkspacePath() : undefined);
    if (path) query.set("path", path);

    const originUrl = this.getStringExtra(target, "originUrl");
    if (originUrl) query.set("originUrl", originUrl);

    const uri = vscode.Uri.parse(`codex://new?${query.toString()}`);

    this.logger.user({ fn: "openCodexDeeplink" }, "Opening Codex Deeplink", {
      target: target.id,
      hasPath: Boolean(path),
      hasOriginUrl: Boolean(originUrl),
      length: prompt.length,
    });

    return vscode.env.openExternal(uri);
  }

  private getWorkspacePath(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
      if (activeFolder?.uri.scheme === "file") return activeFolder.uri.fsPath;
    }

    return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === "file")?.uri.fsPath;
  }

  private getStringExtra(target: PromptTarget, key: string): string | undefined {
    const value = target.extraArgs?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private getBooleanExtra(target: PromptTarget, key: string): boolean | undefined {
    const value = target.extraArgs?.[key];
    return typeof value === "boolean" ? value : undefined;
  }

  private isDispatchMode(value: unknown): value is DispatchMode {
    return (
      value === "string" ||
      value === "object-query" ||
      value === "clipboard" ||
      value === "codex-deeplink" ||
      value === "uia-compose"
    );
  }
}

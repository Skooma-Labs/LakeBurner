import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { Logger, type HostLogEnvelope } from "./Logger";
import type { ProviderMonitor, ProviderInfo } from "../../backend/ProviderMonitor";
import type { ActivityLog, ActivityEntry } from "../../backend/ActivityLog";
import type { AutoRunMode } from "../../backend/AutoRunMode";
import type { AutoClicker } from "../../backend/AutoClicker";
import type { PromptDispatcher, PromptTarget } from "../../backend/PromptDispatcher";
import type { AffectedChats, ChatSessionRecord } from "../../backend/AffectedChats";
import type { ActivityPopout } from "../../backend/ActivityPopout";

type IncomingFromWebview =
  | { type: "webview.ready" }
  | { type: "autoRun.toggle" }
  | { type: "prompt.send"; targetId: string; prompt: string }
  | { type: "prompt.saveDefault"; prompt: string }
  | { type: "affectedChats.setAllowed"; id: string; allowed: boolean }
  | { type: "affectedChats.clear" }
  | { type: "activity.clear" }
  | { type: "activity.copy" }
  | { type: "activity.popout" }
  | HostLogEnvelope
  | { type: string; [key: string]: unknown };

type OutgoingToWebview =
  | { type: "lakeburner.providers"; providers: ProviderInfo[] }
  | { type: "lakeburner.activity"; entries: ActivityEntry[] }
  | { type: "lakeburner.autoRun"; enabled: boolean }
  | { type: "lakeburner.prompt"; targets: PromptTarget[]; defaultPrompt: string }
  | { type: "lakeburner.affectedChats"; sessions: ChatSessionRecord[]; allowedIds: string[] }
  | { type: "lakeburner.error"; reason: string };

function readMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" ? t : undefined;
}

function isHostLogEnvelope(message: IncomingFromWebview): message is HostLogEnvelope {
  if (message.type !== "lakeburner.hostlog") return false;
  const m = message as Partial<HostLogEnvelope>;
  return (
    (m.kind === "TASK" || m.kind === "USER" || m.kind === "INFO" || m.kind === "WARN" || m.kind === "ERROR") &&
    typeof m.file === "string" &&
    typeof m.fn === "string" &&
    typeof m.message === "string"
  );
}

export class WebviewHost implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cfgSection: string,
    private readonly logger: Logger,
    private readonly monitor: ProviderMonitor,
    private readonly activity: ActivityLog,
    private readonly autoRun: AutoRunMode,
    private readonly autoClicker: AutoClicker,
    private readonly dispatcher: PromptDispatcher,
    private readonly affected: AffectedChats,
    private readonly popout: ActivityPopout
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    const distRoot = vscode.Uri.file(path.join(this.context.extensionPath, "dist", "frontend"));

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [distRoot],
    };

    const nonce = crypto.randomBytes(16).toString("base64");
    webviewView.webview.html = this.getWebviewHtml(webviewView.webview, nonce);

    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${this.cfgSection}.initialPrompt.default`) ||
        e.affectsConfiguration(`${this.cfgSection}.initialPrompt.targets`)
      ) {
        this.broadcastPrompt();
      }
    });
    webviewView.onDidDispose(() => cfgSub.dispose());

    webviewView.webview.onDidReceiveMessage(async (raw: unknown) => {
      try {
        const type = readMessageType(raw);
        if (!type) return;

        const incoming = raw as IncomingFromWebview;

        if (isHostLogEnvelope(incoming)) {
          const ctx = { originFile: incoming.file, originFn: incoming.fn, data: incoming.data };
          if (incoming.kind === "ERROR") this.logger.error({ fn: "webview.hostlog" }, incoming.message, ctx);
          else if (incoming.kind === "WARN") this.logger.warn({ fn: "webview.hostlog" }, incoming.message, ctx);
          else if (incoming.kind === "USER") this.logger.user({ fn: "webview.hostlog" }, incoming.message, ctx);
          else if (incoming.kind === "TASK") this.logger.task({ fn: "webview.hostlog" }, incoming.message, ctx);
          else this.logger.info({ fn: "webview.hostlog" }, incoming.message, ctx);
          return;
        }

        switch (incoming.type) {
          case "webview.ready": {
            this.logger.info({ fn: "onDidReceiveMessage" }, "Webview Loaded Successfully");
            this.broadcastProviders();
            this.broadcastActivity();
            this.broadcastAutoRun();
            this.broadcastPrompt();
            this.broadcastAffectedChats();
            return;
          }

          case "autoRun.toggle": {
            const next = await this.autoRun.toggle();
            this.activity.add(
              "INFO",
              next ? "Auto-Run enabled — assistants will be auto-approved" : "Auto-Run disabled — manual approvals required",
              { source: "sidebar" }
            );
            return;
          }

          case "activity.clear": {
            this.logger.user({ fn: "onDidReceiveMessage" }, "Activity Log Cleared");
            this.activity.clear();
            return;
          }

          case "activity.copy": {
            const text = this.activity
              .list()
              .slice()
              .sort((a, b) => a.id - b.id)
              .map((e) => {
                const t = e.tsIso.slice(11, 19);
                const head = `[${t}] ${e.kind} ${e.message}`;
                if (e.data === undefined || e.data === null) return head;
                let body: string;
                try { body = JSON.stringify(e.data, null, 2); } catch { body = String(e.data); }
                return `${head}\n  data: ${body.replace(/\n/g, "\n  ")}`;
              })
              .join("\n");
            await vscode.env.clipboard.writeText(text);
            this.logger.user({ fn: "onDidReceiveMessage" }, "Activity Log Copied", { entries: this.activity.list().length });
            this.activity.add("INFO", `Activity log copied to clipboard (${this.activity.list().length} entries)`);
            return;
          }

          case "activity.popout": {
            this.logger.user({ fn: "onDidReceiveMessage" }, "Activity Popout Opened");
            this.popout.open();
            return;
          }

          case "prompt.send": {
            const targetId = String((incoming as { targetId?: unknown }).targetId ?? "").trim();
            const prompt = String((incoming as { prompt?: unknown }).prompt ?? "");
            if (!targetId || !prompt.trim()) {
              this.logger.warn({ fn: "onDidReceiveMessage" }, "prompt.send Missing Fields", { hasTarget: !!targetId, hasPrompt: !!prompt.trim() });
              return;
            }
            // Register the dispatched chat in Affected Chats and add it to
            // the allowlist. Fingerprint matches the one the chat participant
            // would compute if @lakeburner is later invoked in the same
            // conversation, so the entries collide cleanly.
            await this.affected.registerExternal(prompt);
            await this.dispatcher.send(targetId, prompt);
            return;
          }

          case "prompt.saveDefault": {
            const prompt = String((incoming as { prompt?: unknown }).prompt ?? "");
            await this.dispatcher.setDefaultPrompt(prompt);
            this.broadcastPrompt();
            vscode.window.setStatusBarMessage("LakeBurner: default prompt saved", 2000);
            return;
          }

          case "affectedChats.setAllowed": {
            const id = String((incoming as { id?: unknown }).id ?? "").trim();
            const allowed = !!(incoming as { allowed?: unknown }).allowed;
            if (!id) return;
            await this.affected.setAllowed(id, allowed);
            return;
          }

          case "affectedChats.clear": {
            await this.affected.clear();
            return;
          }

          default:
            this.logger.info({ fn: "onDidReceiveMessage" }, "Message Type Ignored", { type: incoming.type });
            return;
        }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        this.logger.error({ fn: "onDidReceiveMessage" }, "Message Handler Failed", { reason, stack });
        void this.postMessageToWebview({ type: "lakeburner.error", reason });
      }
    });
  }

  public broadcastProviders(): void {
    void this.postMessageToWebview({ type: "lakeburner.providers", providers: this.monitor.list() });
  }

  public broadcastActivity(): void {
    void this.postMessageToWebview({ type: "lakeburner.activity", entries: this.activity.list() });
  }

  public broadcastAutoRun(): void {
    void this.postMessageToWebview({ type: "lakeburner.autoRun", enabled: this.autoRun.isEnabled });
  }

  public broadcastPrompt(): void {
    void this.postMessageToWebview({
      type: "lakeburner.prompt",
      targets: this.dispatcher.listTargets(),
      defaultPrompt: this.dispatcher.getDefaultPrompt(),
    });
  }

  public broadcastAffectedChats(): void {
    void this.postMessageToWebview({
      type: "lakeburner.affectedChats",
      sessions: this.affected.list(),
      allowedIds: this.affected.listAllowedIds(),
    });
  }

  private async postMessageToWebview(payload: OutgoingToWebview): Promise<boolean> {
    if (!this.view) return false;
    return await this.view.webview.postMessage(payload);
  }

  private getWebviewHtml(webview: vscode.Webview, nonce: string): string {
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "dist", "frontend", "styles.css"))
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "dist", "frontend", "ts", "Webview.js"))
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${stylesUri}" />
  <title>LakeBurner</title>
</head>
<body>
  <details class="section">
    <summary class="section-summary"><h2 class="section-title">AI Providers</h2></summary>
    <div id="provider-list" class="provider-list"></div>
  </details>

  <details class="section" open>
    <summary class="section-summary"><h2 class="section-title">Tasks</h2></summary>
    <div class="stack">
      <button id="autoRunBtn" class="btn btn-toggle" type="button" aria-pressed="false"
              title="Auto-approve tool/Keep prompts. Replies 'Keep going, I trust your intuitions' when an assistant asks for direction.">
        <span class="btn-label">Auto-Run</span>
        <span class="btn-state" id="autoRunState">OFF</span>
      </button>
    </div>
  </details>

  <details class="section">
    <summary class="section-summary"><h2 class="section-title">Send Initial Prompt</h2></summary>
    <div class="stack">
      <select id="promptTarget" class="select" aria-label="Chat target"></select>
      <textarea id="promptText" class="textarea" rows="8" placeholder="Type the prompt to seed the chat with..."></textarea>
      <div class="row">
        <button id="sendPromptBtn" class="btn" type="button">Send</button>
        <button id="savePromptBtn" class="btnSmall" type="button" title="Save current text as the default prompt.">Save Default</button>
      </div>
    </div>
  </details>

  <details class="section" open>
    <summary class="section-summary">
      <h2 class="section-title">Affected Chats</h2>
      <button id="clearChatsBtn" class="btnSmall section-action" type="button" title="Clear all tracked chats and the allowlist.">Clear</button>
    </summary>
    <p class="section-hint">Chats Auto-Run will press Allow / Keep on. Add via <strong>Send Initial Prompt</strong> or <code>@lakeburner start</code>; remove via <code>@lakeburner stop</code> in that chat.</p>
    <div id="affected-chats" class="affected-chats" aria-live="polite"></div>
  </details>

  <details class="section" open>
    <summary class="section-summary">
      <h2 class="section-title">Activity</h2>
      <button id="popoutActivityBtn" class="btnSmall section-action" type="button" title="Open Activity in a larger panel beside the editor for real-time monitoring">Popout</button>
      <button id="copyActivityBtn" class="btnSmall section-action" type="button" title="Copy all activity entries to the clipboard">Copy</button>
      <button id="clearActivityBtn" class="btnSmall section-action" type="button">Clear</button>
    </summary>
    <div id="activity-log" class="activity-log" aria-live="polite"></div>
  </details>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

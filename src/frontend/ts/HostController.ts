import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { Logger, type HostLogEnvelope } from "./TSLogger";
import type { ProviderMonitor, ProviderInfo } from "../../backend/ProviderMonitor";
import type { ActivityLog, ActivityEntry } from "../../backend/ActivityLog";

type IncomingFromWebview =
  | { type: "webview.ready" }
  | { type: "function01" }
  | { type: "activity.clear" }
  | HostLogEnvelope
  | { type: string; [key: string]: unknown };

type OutgoingToWebview =
  | { type: "lakeburner.providers"; providers: ProviderInfo[] }
  | { type: "lakeburner.activity"; entries: ActivityEntry[] }
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
    private readonly activity: ActivityLog
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
            return;
          }

          case "function01": {
            this.logger.user({ fn: "onDidReceiveMessage" }, "Function_01 Selected");
            this.activity.add("INFO", "Function_01 invoked from sidebar");
            vscode.window.showInformationMessage(
              `LakeBurner: Function_01 fired. Try \`@lakeburner advise\` in Copilot Chat.`
            );
            return;
          }

          case "activity.clear": {
            this.logger.user({ fn: "onDidReceiveMessage" }, "Activity Log Cleared");
            this.activity.clear();
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
  <section class="section">
    <h2 class="section-title">AI Providers</h2>
    <div id="provider-list" class="provider-list"></div>
  </section>

  <section class="section">
    <h2 class="section-title">Tasks</h2>
    <div class="stack">
      <button class="btn" type="button" data-action="function01">Function_01</button>
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <h2 class="section-title">Activity</h2>
      <button id="clearActivityBtn" class="btnSmall" type="button">Clear</button>
    </div>
    <div id="activity-log" class="activity-log" aria-live="polite"></div>
  </section>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

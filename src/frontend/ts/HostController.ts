import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { Logger, type DebugLevel, type HostLogEnvelope } from "./TSLogger";

type SettingsPayload = {
  url: string;
  name: string;
  folder: string;
  debugLevel: DebugLevel;
};

type SaveSettingsMessage = {
  type: "saveSettings";
  url: string;
  name: string;
  folder: string;
};

type IncomingFromWebview =
  | { type: "webview.ready" }
  | { type: "pickFolder" }
  | SaveSettingsMessage
  | { type: "vscplate.ui.connectionSettings.toggle"; isOpen: boolean }
  | { type: "changeMode"; mode: "Mode_01" | "Mode_02" }
  | { type: "function01" | "function02" | "function03" }
  | { type: "vscplate.apiToken.set"; token: string }
  | { type: "vscplate.apiToken.clear" }
  | { type: "vscplate.apiToken.status" }
  | HostLogEnvelope
  | { type: string; [key: string]: unknown };

type OutgoingToWebview =
  | { type: "vscplate.settings"; settings: SettingsPayload }
  | { type: "pickFolder.result"; path: string }
  | { type: "vscplate.apiToken.status.result"; hasToken: boolean }
  | { type: "vscplate.apiToken.set.result"; ok: boolean; reason?: string }
  | { type: "vscplate.apiToken.clear.result"; ok: boolean; reason?: string }
  | { type: "changeMode"; mode: "Mode_01" | "Mode_02" }
  | { type: "vscplate.error"; ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readMessageType(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const typeValue = (value as any).type;
  return typeof typeValue === "string" ? typeValue : undefined;
}

function isSaveSettingsMessage(message: IncomingFromWebview): message is SaveSettingsMessage {
  if (message.type !== "saveSettings") return false;

  const urlValue = (message as any).url;
  const nameValue = (message as any).name;
  const folderValue = (message as any).folder;

  return (
    typeof urlValue === "string" &&
    typeof nameValue === "string" &&
    typeof folderValue === "string"
  );
}

function isHostLogEnvelope(message: IncomingFromWebview): message is HostLogEnvelope {
  if (message.type !== "vscplate.hostlog") return false;

  const kindValue = (message as any).kind;
  const fileValue = (message as any).file;
  const fnValue = (message as any).fn;
  const messageValue = (message as any).message;

  return (
    (kindValue === "TASK" ||
      kindValue === "USER" ||
      kindValue === "INFO" ||
      kindValue === "WARN" ||
      kindValue === "ERROR") &&
    typeof fileValue === "string" &&
    typeof fnValue === "string" &&
    typeof messageValue === "string"
  );
}

function readModeFromMessage(msg: IncomingFromWebview): "Mode_01" | "Mode_02" | undefined {
  if (msg.type !== "changeMode") return undefined;
  const m = (msg as any).mode;
  return m === "Mode_01" || m === "Mode_02" ? m : undefined;
}

function readConnSettingsToggle(msg: IncomingFromWebview): boolean | undefined {
  if (msg.type !== "vscplate.ui.connectionSettings.toggle") return undefined;
  const v = (msg as any).isOpen;
  return typeof v === "boolean" ? v : undefined;
}

function readTokenFromMessage(msg: IncomingFromWebview): string | undefined {
  if (msg.type !== "vscplate.apiToken.set") return undefined;
  const token = (msg as any).token;
  return typeof token === "string" ? token.trim() : undefined;
}

export class WebviewHost implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  private configChangeSub?: vscode.Disposable;
  private lastPushedSettingsJson: string = "";

  private static readonly MODE_KEY = "vscplate.currentMode";
  private currentMode: "Mode_01" | "Mode_02" = "Mode_01";

  private readPersistedMode(): "Mode_01" | "Mode_02" {
    const v = this.context.globalState.get<string>(WebviewHost.MODE_KEY);
    return v === "Mode_02" ? "Mode_02" : "Mode_01";
  }

  private async persistMode(mode: "Mode_01" | "Mode_02"): Promise<void> {
    await this.context.globalState.update(WebviewHost.MODE_KEY, mode);
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly cfgSection: string,
    private readonly logger: Logger
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    this.currentMode = this.readPersistedMode();
    this.logger.info({ fn: "resolveWebviewView" }, "Web View Resolved", { mode: this.currentMode });

    const distRoot = vscode.Uri.file(path.join(this.context.extensionPath, "dist", "frontend"));

    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [distRoot],
    };

    const nonce = crypto.randomBytes(16).toString("base64");
    this.view.webview.html = this.getWebviewHtml(this.view.webview, nonce);

    this.configChangeSub?.dispose();
    this.configChangeSub = vscode.workspace.onDidChangeConfiguration(async (e) => {
      try {
        const affects =
          e.affectsConfiguration(`${this.cfgSection}.url`) ||
          e.affectsConfiguration(`${this.cfgSection}.name`) ||
          e.affectsConfiguration(`${this.cfgSection}.folder`) ||
          e.affectsConfiguration(`${this.cfgSection}.debugLevel`);

        if (!affects) return;

        this.logger.info(
          { fn: "onDidChangeConfiguration" },
          "VSCode Settings syncing to VscPlate UI",
          { section: this.cfgSection }
        );

        await this.pushSettingsToWebview();
        await this.pushTokenStatus();
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn({ fn: "onDidChangeConfiguration" }, "Settings Failed to Sync", { reason });
      }
    });

    this.view.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
      try {
        const type = readMessageType(rawMessage);
        if (!type) return;

        const incoming = rawMessage as IncomingFromWebview;

        switch (incoming.type) {
          case "vscplate.hostlog": {
            if (!isHostLogEnvelope(incoming)) return;

            const originFile = String(incoming.file ?? "webview");
            const originFn = String(incoming.fn ?? "unknown");
            const originMsg = String(incoming.message ?? "");
            const originData = incoming.data;

            const ctx = { originFile, originFn, data: originData };

            if (incoming.kind === "ERROR") this.logger.error({ fn: "webview.hostlog" }, originMsg, ctx);
            else if (incoming.kind === "WARN") this.logger.warn({ fn: "webview.hostlog" }, originMsg, ctx);
            else if (incoming.kind === "USER") this.logger.user({ fn: "webview.hostlog" }, originMsg, ctx);
            else if (incoming.kind === "TASK") this.logger.task({ fn: "webview.hostlog" }, originMsg, ctx);
            else this.logger.info({ fn: "webview.hostlog" }, originMsg, ctx);

            return;
          }

          case "webview.ready": {
            this.logger.info({ fn: "onDidReceiveMessage" }, "Webview Loaded Successfully");

            await this.pushSettingsToWebview();
            await this.pushTokenStatus();

            void this.postMessageToWebview({
              type: "changeMode",
              mode: this.currentMode,
            });

            return;
          }

          case "pickFolder": {
            this.logger.user({ fn: "onDidReceiveMessage" }, "Folder Picker Opened");

            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              openLabel: "Select Folder",
            });

            const selectedFolder = picked?.[0];
            if (selectedFolder) {
              this.logger.task({ fn: "onDidReceiveMessage" }, "Folder Selected", {
                path: selectedFolder.fsPath,
              });
              void this.postMessageToWebview({
                type: "pickFolder.result",
                path: selectedFolder.fsPath,
              });
            } else {
              this.logger.task({ fn: "onDidReceiveMessage" }, "Folder Navigation Closed");
            }
            return;
          }

          case "saveSettings": {
            if (!isSaveSettingsMessage(incoming)) return;

            this.logger.user({ fn: "onDidReceiveMessage" }, "Connection-Settings Saved");
            await this.saveSettings(incoming);
            await this.pushSettingsToWebview();

            this.view?.show?.(true);
            vscode.window.showInformationMessage("Settings Saved");
            return;
          }

          case "changeMode": {
            const m = readModeFromMessage(incoming);
            if (!m) return;

            this.currentMode = m;
            await this.persistMode(m);

            this.logger.user(
              { fn: "onDidReceiveMessage" },
              `Mode toggled to ${m}`,
              { mode: m }
            );
            return;
          }

          case "vscplate.ui.connectionSettings.toggle": {
            const isOpen = readConnSettingsToggle(incoming);
            if (typeof isOpen !== "boolean") return;

            this.logger.user(
              { fn: "onDidReceiveMessage" },
              isOpen ? "Connection-Settings Expanded" : "Connection-Settings Collapsed",
              { isOpen }
            );

            return;
          }

          case "vscplate.apiToken.set": {
            const token = readTokenFromMessage(incoming);
            if (!token) {
              void this.postMessageToWebview({
                type: "vscplate.apiToken.set.result",
                ok: false,
                reason: "Token Provided was Empty.",
              });
              this.logger.warn({ fn: "onDidReceiveMessage" }, "Empty Token, Save Rejected");
              return;
            }

            await this.context.secrets.store("vscplate.apiToken", token);
            this.logger.user({ fn: "onDidReceiveMessage" }, "API Token Saved Successfully");
            void this.postMessageToWebview({ type: "vscplate.apiToken.set.result", ok: true });
            await this.pushTokenStatus();
            return;
          }

          case "vscplate.apiToken.clear": {
            await this.context.secrets.delete("vscplate.apiToken");
            this.logger.user({ fn: "onDidReceiveMessage" }, "API Token was Cleared");
            void this.postMessageToWebview({ type: "vscplate.apiToken.clear.result", ok: true });
            await this.pushTokenStatus();
            return;
          }

          case "vscplate.apiToken.status": {
            this.logger.info({ fn: "onDidReceiveMessage" }, "API Token Status Requested");
            await this.pushTokenStatus();
            return;
          }

          case "function01":
          case "function02":
          case "function03": {
            const action = incoming.type;

            if (action === "function01") this.logger.user({ fn: "onDidReceiveMessage" }, "\"Function_01\" Selected");
            else if (action === "function02") this.logger.user({ fn: "onDidReceiveMessage" }, "\"Function_02\" Selected");
            else this.logger.user({ fn: "onDidReceiveMessage" }, "\"Function_03\" Selected");

            await this.runTask(action);
            return;
          }

          default:
            this.logger.info({ fn: "onDidReceiveMessage" }, "Message Type Ignored", { type: incoming.type });
            return;
        }
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;

        this.logger.error({ fn: "onDidReceiveMessage" }, "Message Handler Failed", { reason, stack });
        void this.postMessageToWebview({ type: "vscplate.error", ok: false, reason });
      }
    });
  }

  private async runTask(task: "function01" | "function02" | "function03"): Promise<void> {
    const mode = this.currentMode;

    this.logger.task({ fn: "runTask" }, "Task Started", { task, mode });

    // TODO: Replace with your business logic.
    // Each branch receives the current mode and can prompt for input, call APIs, etc.

    const id = await this.promptInputId(task);
    if (!id) return;

    this.logger.task({ fn: "runTask" }, "Task Executed (stub)", { task, mode, inputId: id });
    this.output.appendLine(`[${task}] executed with InputId=${id}, Mode=${mode}`);
    vscode.window.showInformationMessage(`VscPlate: ${task} completed (InputId=${id}, Mode=${mode}).`);
  }

  private async promptInputId(title: string): Promise<string | undefined> {
    this.logger.info({ fn: "promptInputId" }, "Input ID Prompted", { title });

    const v = await vscode.window.showInputBox({
      title,
      prompt: "Please Type an Input ID and Press 'Enter'",
      placeHolder: "e.g. 123456",
      validateInput: (value) => {
        const t = (value ?? "").trim();
        if (!t) return "Input ID Required";
        return undefined;
      },
    });

    const id = (v ?? "").trim();

    if (!id) {
      this.logger.info({ fn: "promptInputId" }, "Input ID Entry Cancelled", { title });
      return undefined;
    }

    this.logger.task({ fn: "promptInputId" }, "Input ID Provided Successfully", { inputId: id });
    return id;
  }

  private async pushTokenStatus(): Promise<void> {
    const token = (await this.context.secrets.get("vscplate.apiToken"))?.trim() ?? "";
    void this.postMessageToWebview({ type: "vscplate.apiToken.status.result", hasToken: !!token });
  }

  private async postMessageToWebview(payload: OutgoingToWebview): Promise<boolean> {
    if (!this.view) {
      this.logger.warn({ fn: "postMessageToWebview" }, "'postMessage' Skipped (No View Found)", {
        type: (payload as any)?.type,
      });
      return false;
    }

    const ok = await this.view.webview.postMessage(payload);

    this.logger.info({ fn: "postMessageToWebview" }, "'postMessage' Sent", {
      type: (payload as any)?.type,
      ok,
    });

    return ok;
  }

  private readSettings(): SettingsPayload {
    const configuration = vscode.workspace.getConfiguration(this.cfgSection);

    const url = String(configuration.get("url", "")).trim();
    const name = String(configuration.get("name", "")).trim();
    const folder = String(configuration.get("folder", "")).trim();

    this.logger.reloadLevel();
    const debugLevel = this.logger.getLevel();

    return { url, name, folder, debugLevel };
  }

  private async pushSettingsToWebview(): Promise<void> {
    const settings = this.readSettings();

    const settingsJson = JSON.stringify(settings);
    if (settingsJson !== this.lastPushedSettingsJson) {
      this.lastPushedSettingsJson = settingsJson;
      this.logger.info({ fn: "pushSettingsToWebview" }, "Settings Synced to VscPlate UI", {
        url: !!settings.url,
        name: !!settings.name,
        folder: !!settings.folder,
        debugLevel: settings.debugLevel,
      });
    } else {
      this.logger.info({ fn: "pushSettingsToWebview" }, "Settings Unchanged", {
        debugLevel: settings.debugLevel,
      });
    }

    void this.postMessageToWebview({ type: "vscplate.settings", settings });
  }

  private async saveSettings(message: SaveSettingsMessage): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(this.cfgSection);

    const url = String(message.url ?? "").trim();
    const name = String(message.name ?? "").trim();
    const folder = String(message.folder ?? "").trim();

    if (url) await configuration.update("url", url, vscode.ConfigurationTarget.Global);
    if (name) await configuration.update("name", name, vscode.ConfigurationTarget.Global);

    if (folder) {
      await configuration.update("folder", folder, vscode.ConfigurationTarget.Global);
    }
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
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} https:`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${stylesUri}" />
  <title>VscPlate Extension</title>
</head>
<body>
  <h1>TASKS</h1>

  <div class="mode-toggle" role="group" aria-label="Select Mode">
    <button id="modeOneBtn" class="mode-btn is-active" type="button" aria-pressed="true">Mode_01</button>
    <button id="modeTwoBtn" class="mode-btn" type="button" aria-pressed="false">Mode_02</button>
  </div>

  <div class="stack">
    <button class="btn" type="button" data-action="function01">Function_01</button>
    <button class="btn" type="button" data-action="function02">Function_02</button>
    <button class="btn" type="button" data-action="function03">Function_03</button>
  </div>

  <div class="collapsible collapsed" id="connection-settings">
    <div class="collapsible-header" id="connection-settings-toggle">
      <span class="arrow" id="connection-settings-arrow">â–¸</span>
      <span class="title">Connection Settings</span>
    </div>
    <div class="collapsible-body">
      <div class="panel">
        <div class="form">
          <div class="field">
            <label for="apiToken">API Token</label>
            <input id="apiToken" type="password" autocomplete="off" spellcheck="false" placeholder="Personal Access Token" />
          </div>
          <div class="field">
            <label for="settingUrl">URL</label>
            <input id="settingUrl" type="text" spellcheck="false" placeholder="https://your-service.example.com/" />
          </div>
          <div class="field">
            <label for="settingName">Name</label>
            <input id="settingName" type="text" spellcheck="false" placeholder="My Project" />
          </div>
          <div class="field">
            <label for="settingFolder">Set Folder</label>
            <div class="row">
              <input id="settingFolder" type="text" spellcheck="false" />
              <button class="btnSmall" id="pickFolder" type="button" aria-label="Open Folder Picker">Open</button>
            </div>
          </div>
          <div class="row">
            <button class="btnSmall" id="saveSettings" type="button" aria-label="Save Settings">Save</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

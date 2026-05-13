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
  | { type: "singletMode.toggle" }
  | { type: "prompt.send"; targetId: string; prompt: string }
  | { type: "prompt.saveDefault"; prompt: string }
  | { type: "affectedChats.remove"; id: string }
  | { type: "affectedChats.clear" }
  | { type: "activity.clear" }
  | { type: "activity.copy" }
  | { type: "activity.popout" }  | { type: "provider.switch"; id: string }
  | { type: "provider.login"; id: string }
  | { type: "settings.open" }
  | HostLogEnvelope
  | { type: string; [key: string]: unknown };

type OutgoingToWebview =
  | { type: "lakeburner.providers"; providers: ProviderInfo[] }
  | { type: "lakeburner.activity"; entries: ActivityEntry[] }
  | { type: "lakeburner.autoRun"; enabled: boolean }
  | { type: "lakeburner.singletMode"; enabled: boolean }
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
      if (e.affectsConfiguration(`${this.cfgSection}.singletMode.enabled`)) {
        this.broadcastSingletMode();
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
            this.broadcastSingletMode();
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

          case "singletMode.toggle": {
            const cfg = vscode.workspace.getConfiguration(this.cfgSection);
            const current = cfg.get<boolean>("singletMode.enabled", false);
            await cfg.update("singletMode.enabled", !current, vscode.ConfigurationTarget.Global);
            this.logger.user({ fn: "onDidReceiveMessage" }, `Singlet Mode ${!current ? "Enabled" : "Disabled"}`);
            this.activity.add("INFO", `Singlet Mode ${!current ? "enabled — session will end on first idle" : "disabled — Keep Going will nudge as normal"}`);
            this.broadcastSingletMode();
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
              // Broadcast so the webview reconciles the button back to "Start".
              this.broadcastAutoRun();
              this.broadcastAffectedChats();
              return;
            }
            // Dispatch first — only arm Auto-Run + Affected Chats on success.
            const result = await this.dispatcher.send(targetId, prompt);
            if (result.ok) {
              await this.autoRun.setEnabled(true);
              // Register the dispatched chat in Affected Chats and add it to
              // the allowlist. Fingerprint matches the one the chat participant
              // would compute if @lakeburner is later invoked in the same
              // conversation, so the entries collide cleanly.
              await this.affected.registerExternal(prompt);
              // Remember which overlord was selected so the Keep Going ticker
              // nudges the same target instead of reading the legacy setting.
              await this.affected.setActiveTargetId(targetId);
            } else {
              this.activity.add("BLOCK", `Start a Chat failed: ${result.reason ?? "dispatch returned not-ok"}`, { targetId });
            }
            this.broadcastAutoRun();
            this.broadcastAffectedChats();
            return;
          }

          case "prompt.saveDefault": {
            const prompt = String((incoming as { prompt?: unknown }).prompt ?? "");
            await this.dispatcher.setDefaultPrompt(prompt);
            this.broadcastPrompt();
            vscode.window.setStatusBarMessage("LakeBurner: default prompt saved", 2000);
            return;
          }

          case "affectedChats.remove": {
            const id = String((incoming as { id?: unknown }).id ?? "").trim();
            if (!id) return;
            await this.affected.removeSession(id);
            return;
          }

          case "affectedChats.clear": {
            await this.affected.clear();
            return;
          }

          case "provider.switch": {
            const id = String((incoming as { id?: unknown }).id ?? "").trim();
            if (!id) return;
            await this.handleSwitchUser(id);
            return;
          }

          case "provider.login": {
            const id = String((incoming as { id?: unknown }).id ?? "").trim();
            if (!id) return;
            // Open Extensions view filtered to the provider
            await vscode.commands.executeCommand("workbench.extensions.search", id);
            this.logger.user({ fn: "onDidReceiveMessage" }, "Provider Login/Install", { id });
            return;
          }

          case "settings.open": {
            await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${this.context.extension.id}`);
            this.logger.user({ fn: "onDidReceiveMessage" }, "Settings Opened");
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
        // Always broadcast state so the webview can reconcile (e.g. un-stick
        // the Start button after a failed prompt.send).
        this.broadcastAutoRun();
        this.broadcastAffectedChats();
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

  public broadcastSingletMode(): void {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    void this.postMessageToWebview({ type: "lakeburner.singletMode", enabled: cfg.get<boolean>("singletMode.enabled", false) });
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

  public async manageAccounts(): Promise<void> {
    const providers = this.monitor.list();
    const providerItems: vscode.QuickPickItem[] = providers.map((p) => ({
      label: p.label,
      description: p.id,
    }));
    if (providerItems.length === 0) {
      vscode.window.showInformationMessage("LakeBurner: No providers configured.");
      return;
    }
    const pick = await vscode.window.showQuickPick(providerItems, {
      title: "LakeBurner: Manage Accounts",
      placeHolder: "Select a provider to manage accounts for",
    });
    if (!pick) return;
    const providerId = pick.description!;
    await this.handleSwitchUser(providerId);
  }

  private async postMessageToWebview(payload: OutgoingToWebview): Promise<boolean> {
    if (!this.view) return false;
    return await this.view.webview.postMessage(payload);
  }

  private async handleSwitchUser(providerId: string): Promise<void> {
    const secretKey = `lakeburner.accounts.${providerId}`;
    const raw = await this.context.secrets.get(secretKey);
    let accounts: { email: string; password: string }[] = [];
    try {
      accounts = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(accounts)) accounts = [];
    } catch {
      accounts = [];
    }

    // Find the provider label for display.
    const providers = this.monitor.list();
    const providerLabel = providers.find((p) => p.id === providerId)?.label ?? providerId;

    let selectedEmail: string | undefined;

    if (accounts.length > 0) {
      const items: vscode.QuickPickItem[] = [
        ...accounts.map((a) => ({ label: a.email, description: "Stored account" })),
        { label: "", description: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(add) Connect another account", description: "Add a new email + password" },
        { label: "$(edit) Edit password", description: "Update the password for a stored account" },
        { label: "$(trash) Remove account", description: "Delete a stored account" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `LakeBurner: Switch User — ${providerLabel}`,
        placeHolder: "Select an account or manage credentials",
      });
      if (!pick) return;

      if (pick.label === "$(edit) Edit password") {
        await this.handleEditPassword(secretKey, providerLabel, accounts);
        return;
      }
      if (pick.label === "$(trash) Remove account") {
        await this.handleRemoveAccount(secretKey, providerLabel, accounts);
        return;
      }
      if (!pick.label.startsWith("$(")) {
        selectedEmail = pick.label;
      }
    }

    if (!selectedEmail) {
      const email = await vscode.window.showInputBox({
        title: `LakeBurner: Connect to ${providerLabel}`,
        prompt: "Enter your email address",
        placeHolder: "user@example.com",
        ignoreFocusOut: true,
        validateInput: (v) => (v.includes("@") ? null : "Please enter a valid email"),
      });
      if (!email) return;

      const password = await vscode.window.showInputBox({
        title: `LakeBurner: Connect to ${providerLabel}`,
        prompt: "Enter your password",
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return;

      const existing = accounts.find((a) => a.email === email);
      if (existing) {
        existing.password = password;
      } else {
        accounts.push({ email, password });
      }
      await this.context.secrets.store(secretKey, JSON.stringify(accounts));
      selectedEmail = email;
      this.logger.user({ fn: "handleSwitchUser" }, "Account Stored", { providerId, email });
    }

    this.activity.add("INFO", `Switched to ${selectedEmail} for ${providerLabel}`, { providerId, email: selectedEmail });
    vscode.window.showInformationMessage(`LakeBurner: Switched to ${selectedEmail} for ${providerLabel}`);
    this.logger.user({ fn: "handleSwitchUser" }, "User Switched", { providerId, email: selectedEmail });
  }

  private async handleEditPassword(
    secretKey: string,
    providerLabel: string,
    accounts: { email: string; password: string }[]
  ): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      accounts.map((a) => ({ label: a.email })),
      { title: `LakeBurner: Edit Password — ${providerLabel}`, placeHolder: "Select the account to update" }
    );
    if (!pick) return;

    const account = accounts.find((a) => a.email === pick.label);
    if (!account) return;

    const password = await vscode.window.showInputBox({
      title: `LakeBurner: New Password — ${pick.label}`,
      prompt: "Enter the new password",
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;

    account.password = password;
    await this.context.secrets.store(secretKey, JSON.stringify(accounts));
    this.logger.user({ fn: "handleEditPassword" }, "Password Updated", { email: pick.label });
    vscode.window.showInformationMessage(`LakeBurner: Password updated for ${pick.label}`);
  }

  private async handleRemoveAccount(
    secretKey: string,
    providerLabel: string,
    accounts: { email: string; password: string }[]
  ): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      accounts.map((a) => ({ label: a.email })),
      { title: `LakeBurner: Remove Account — ${providerLabel}`, placeHolder: "Select the account to remove" }
    );
    if (!pick) return;

    const updated = accounts.filter((a) => a.email !== pick.label);
    await this.context.secrets.store(secretKey, JSON.stringify(updated));
    this.logger.user({ fn: "handleRemoveAccount" }, "Account Removed", { email: pick.label });
    vscode.window.showInformationMessage(`LakeBurner: Removed ${pick.label}`);
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
  <details class="section" open>
    <summary class="section-summary"><h2 class="section-title">Start a Chat</h2></summary>
    <div class="stack">
      <select id="promptTarget" class="select" aria-label="Chat target"></select>
      <textarea id="promptText" class="textarea" rows="8" placeholder="Type the prompt to seed the chat with..."></textarea>
      <label class="checkbox-row"><input type="checkbox" id="singletModeCheckbox" /> Singlet Mode</label>
      <button id="sendPromptBtn" class="btn btn-block" type="button">Start</button>
    </div>
  </details>

  <details class="section" id="active-fires-section">
    <summary class="section-summary">
      <h2 class="section-title">Active Fires</h2>
    </summary>
    <div id="affected-chats" class="affected-chats" aria-live="polite"></div>
  </details>

  <details class="section" id="activity-section">
    <summary class="section-summary">
      <h2 class="section-title">Activity</h2>
      <button id="popoutActivityBtn" class="icon-btn section-action" type="button" aria-label="Popout" data-tooltip="Popout"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1h6v6h-1V3.5L8.5 9 8 8.5 13.5 3H10V2h5v5h-1V3.5zM2 3h5v1H3v9h9V8h1v6H2V3z"/></svg></button>
      <button id="copyActivityBtn" class="icon-btn section-action" type="button" aria-label="Copy" data-tooltip="Copy"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4v10h8V4H4zm7 9H5V5h6v8zM2 2v10h1V3h7V2H2z"/></svg></button>
      <button id="clearActivityBtn" class="icon-btn section-action" type="button" aria-label="Clear" data-tooltip="Clear"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zm-1 0V2H7v1h2zm-4 1v9h6V4H5zm2 2h1v5H7V6zm2 0h1v5H9V6z"/></svg></button>
    </summary>
    <div class="stack">
      <select id="activitySessionFilter" class="select" aria-label="Filter by session"></select>
      <div id="activity-log" class="activity-log" aria-live="polite"></div>
      <button id="copyActivityInlineBtn" class="btn btn-block btn-secondary" type="button">Copy to Clipboard</button>
    </div>
  </details>

  <details class="section">
    <summary class="section-summary">
      <h2 class="section-title">Overlords</h2>
      <button id="openSettingsBtn" class="icon-btn section-action" type="button" aria-label="Settings" data-tooltip="Settings"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.3.7L2 7.4v1.2l2.4.5.3.7-1.3 2 .8.8 2-1.3.7.3.5 2.4h1.2l.5-2.4.7-.3 2 1.3.8-.8-1.3-2 .3-.7 2.4-.5V7.4l-2.4-.5-.3-.7 1.3-2-.8-.8-2 1.3-.7-.3zM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg></button>
    </summary>
    <div id="provider-list" class="provider-list"></div>
  </details>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

import * as vscode from "vscode";
import { WebviewHost } from "./frontend/ts/HostController";
import { Logger } from "./frontend/ts/TSLogger";
import { ProviderMonitor } from "./backend/ProviderMonitor";
import { registerLakeBurnerParticipant } from "./backend/ChatParticipant";
import { ActivityLog } from "./backend/ActivityLog";
import { AutoRunMode } from "./backend/AutoRunMode";
import { registerLakeBurnerLmTools } from "./backend/LmTools";
import { AutoClicker } from "./backend/AutoClicker";
import { UIAAutoClicker } from "./backend/UIAAutoClicker";
import { AutoRunTicker } from "./backend/AutoRunTicker";
import { AffectedChats } from "./backend/AffectedChats";
import { PromptDispatcher } from "./backend/PromptDispatcher";

const CFG_SECTION = "lakeburner";

export function activate(context: vscode.ExtensionContext) {
  const logger = Logger.create(context, "LakeBurner", CFG_SECTION, "main.ts");
  logger.info({ fn: "activate" }, "Extension Activation Started", { debugLevel: logger.getLevel() });

  const activity = new ActivityLog(logger);
  const monitor = new ProviderMonitor(logger, CFG_SECTION);
  const autoRun = new AutoRunMode(context, logger);
  const affected = new AffectedChats(context, CFG_SECTION, logger);
  // Reset the Affected Chats registry on every activation so each LakeBurner
  // session starts cold — no chats are armed until the user explicitly arms
  // one (Send Initial Prompt or @lakeburner start). Fire-and-forget; the
  // globalState write is fast and not awaited by anything below.
  void affected.clearAll().then(() => {
    activity.add("INFO", "Affected Chats reset for new session");
  });
  const uia = new UIAAutoClicker(CFG_SECTION, logger, activity);
  const autoClicker = new AutoClicker(CFG_SECTION, logger, activity, context, uia);
  const dispatcher = new PromptDispatcher(CFG_SECTION, logger, activity);
  const ticker = new AutoRunTicker(CFG_SECTION, logger, autoRun, autoClicker, affected, activity);
  ticker.start(context);

  const provider = new WebviewHost(context, CFG_SECTION, logger, monitor, activity, autoRun, autoClicker, dispatcher, affected);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lakeburner-view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  monitor.start(context, () => provider.broadcastProviders());
  context.subscriptions.push(activity.onChange(() => provider.broadcastActivity()));
  context.subscriptions.push(autoRun.onChange(() => provider.broadcastAutoRun()));
  context.subscriptions.push(affected.onChange(() => provider.broadcastAffectedChats()));

  registerLakeBurnerParticipant(context, logger, activity, autoRun, CFG_SECTION, affected);
  registerLakeBurnerLmTools(context, logger, autoRun, activity);

  context.subscriptions.push(
    vscode.commands.registerCommand("lakeburner.autoRun.toggle", async () => {
      const next = await autoRun.toggle();
      vscode.window.showInformationMessage(`LakeBurner Auto-Run is now ${next ? "ON" : "OFF"}.`);
    }),
    vscode.commands.registerCommand("lakeburner.autoClick.keep", async () => {
      const result = await autoClicker.pressKeep();
      if (result.ok) {
        vscode.window.setStatusBarMessage(
          `LakeBurner: Keep pressed via ${result.via}${result.commandId ? ` (${result.commandId})` : ""}`,
          3000
        );
      } else {
        vscode.window.showWarningMessage(
          "LakeBurner: no Keep command succeeded and the coordinate fallback is unavailable. See Output → LakeBurner."
        );
      }
    }),
    vscode.commands.registerCommand("lakeburner.autoClick.calibrate", () => autoClicker.calibrateFallbackPosition()),
    vscode.commands.registerCommand("lakeburner.autoClick.allow", async () => {
      const result = await autoClicker.pressAllow();
      if (result.ok) {
        vscode.window.setStatusBarMessage(
          `LakeBurner: Allow pressed via ${result.via}${result.commandId ? ` (${result.commandId})` : ""}`,
          3000
        );
      } else {
        vscode.window.showWarningMessage(
          "LakeBurner: no Allow command succeeded and the coordinate fallback is unavailable. See Output \u2192 LakeBurner."
        );
      }
    }),
    vscode.commands.registerCommand("lakeburner.autoClick.calibrateAllow", () => autoClicker.calibrateAllowPosition()),
    vscode.commands.registerCommand("lakeburner.sendInitialPrompt", async (arg?: { targetId?: string; prompt?: string }) => {
      const targets = dispatcher.listTargets();
      let targetId = arg?.targetId;
      if (!targetId) {
        const pick = await vscode.window.showQuickPick(
          targets.map((t) => ({ label: t.label, description: t.command, id: t.id })),
          { title: "LakeBurner: Send Initial Prompt", placeHolder: "Select a chat target" }
        );
        if (!pick) return;
        targetId = pick.id;
      }
      let prompt = arg?.prompt ?? dispatcher.getDefaultPrompt();
      if (!prompt) {
        prompt = (await vscode.window.showInputBox({
          title: "LakeBurner: Initial Prompt",
          prompt: "What should the assistant start with?",
          ignoreFocusOut: true,
        })) ?? "";
      }
      if (!prompt.trim()) return;
      await dispatcher.send(targetId, prompt);
    })
  );

  logger.info({ fn: "activate" }, "LakeBurner Ready", { autoRun: autoRun.isEnabled });
}

export function deactivate() {}

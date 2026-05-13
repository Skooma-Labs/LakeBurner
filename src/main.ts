import * as vscode from "vscode";
import { WebviewHost } from "./frontend/ts/HostController";
import { Logger } from "./frontend/ts/Logger";
import { ProviderMonitor } from "./backend/ProviderMonitor";
import { registerLakeBurnerParticipant } from "./backend/ChatParticipant";
import { ActivityLog } from "./backend/ActivityLog";
import { ActivityPopout } from "./backend/ActivityPopout";
import { AutoRunMode } from "./backend/AutoRunMode";
import { registerLakeBurnerLmTools } from "./backend/LmTools";
import { AutoClicker } from "./backend/AutoClicker";
import { UIAAutoClicker } from "./backend/UIAAutoClicker";
import { AutoRunTicker } from "./backend/AutoRunTicker";
import { AffectedChats } from "./backend/AffectedChats";
import { PromptDispatcher } from "./backend/PromptDispatcher";
import { LocalCommandListener } from "./backend/LocalCommandListener";

const CFG_SECTION = "lakeburner";

export async function activate(context: vscode.ExtensionContext) {
  const logger = Logger.create(context, "LakeBurner", CFG_SECTION, "main.ts");
  logger.info({ fn: "activate" }, "Extension Activation Started", { debugLevel: logger.getLevel() });

  const activity = new ActivityLog(logger);
  const monitor = new ProviderMonitor(logger, CFG_SECTION);
  const autoRun = new AutoRunMode(context, logger);
  const affected = new AffectedChats(context, logger);
  // Reset the Active Fires registry on every activation so each LakeBurner
  // session starts cold; no chats are active until the user explicitly starts
  // one (Start a Chat or @lakeburner start).
  await affected.clearAll();
  activity.add("INFO", "Active Fires reset for new session");
  const uia = new UIAAutoClicker(CFG_SECTION, logger, activity);
  const autoClicker = new AutoClicker(CFG_SECTION, logger, activity, context, uia);
  const dispatcher = new PromptDispatcher(CFG_SECTION, logger, activity);
  const ticker = new AutoRunTicker(CFG_SECTION, logger, autoRun, autoClicker, affected, activity, dispatcher);
  ticker.start(context);

  const popout = new ActivityPopout(context, activity, affected);
  context.subscriptions.push(popout);

  const provider = new WebviewHost(context, CFG_SECTION, logger, monitor, activity, autoRun, autoClicker, dispatcher, affected, popout);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lakeburner-view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  monitor.start(context, () => provider.broadcastProviders());
  context.subscriptions.push(activity.onChange(() => provider.broadcastActivity()));
  context.subscriptions.push(autoRun.onChange(() => provider.broadcastAutoRun()));
  context.subscriptions.push(affected.onChange(() => provider.broadcastAffectedChats()));

  registerLakeBurnerParticipant(context, logger, activity, autoRun, CFG_SECTION, affected, dispatcher);
  registerLakeBurnerLmTools(context, logger, autoRun, activity);

  const localListener = new LocalCommandListener(CFG_SECTION, logger, dispatcher, autoRun, affected);
  localListener.start(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("lakeburner.autoRun.toggle", async () => {
      const next = await autoRun.toggle();
      if (!next) await affected.clear();
      vscode.window.showInformationMessage(`LakeBurner Auto-Run is now ${next ? "ON" : "OFF"}.`);
    }),
    vscode.commands.registerCommand("lakeburner.activity.popout", () => popout.open()),
    vscode.commands.registerCommand("lakeburner.manageAccounts", () => provider.manageAccounts()),
    vscode.commands.registerCommand("lakeburner.sendInitialPrompt", async (arg?: { targetId?: string; prompt?: string }) => {
      const targets = dispatcher.listTargets();
      let targetId = arg?.targetId;
      if (!targetId) {
        const pick = await vscode.window.showQuickPick(
          targets.map((t) => ({ label: t.label, description: t.command, id: t.id })),
          { title: "LakeBurner: Start a Chat", placeHolder: "Select a chat target" }
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
      const result = await dispatcher.send(targetId, prompt);
      if (result.ok) {
        await autoRun.setEnabled(true);
        await affected.registerExternal(prompt);
        await affected.setActiveTargetId(targetId);
      } else {
        vscode.window.showWarningMessage(`LakeBurner: failed to start chat. ${result.reason ?? "Dispatch returned not-ok."}`);
      }
    })
  );

  logger.info({ fn: "activate" }, "LakeBurner Ready", { autoRun: autoRun.isEnabled });
}

export function deactivate() {}

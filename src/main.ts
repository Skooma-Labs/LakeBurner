import * as vscode from "vscode";
import { WebviewHost } from "./frontend/ts/HostController";
import { Logger } from "./frontend/ts/TSLogger";
import { ProviderMonitor } from "./backend/ProviderMonitor";
import { registerLakeBurnerParticipant } from "./backend/ChatParticipant";
import { ActivityLog } from "./backend/ActivityLog";
import { AutoRunMode } from "./backend/AutoRunMode";
import { registerLakeBurnerLmTools } from "./backend/LmTools";
import { AutoClicker } from "./backend/AutoClicker";

const CFG_SECTION = "lakeburner";

export function activate(context: vscode.ExtensionContext) {
  const logger = Logger.create(context, "LakeBurner", CFG_SECTION, "main.ts");
  logger.info({ fn: "activate" }, "Extension Activation Started", { debugLevel: logger.getLevel() });

  const activity = new ActivityLog(logger);
  const monitor = new ProviderMonitor(logger, CFG_SECTION);
  const autoRun = new AutoRunMode(context, logger);
  const autoClicker = new AutoClicker(CFG_SECTION, logger, activity, context);

  const provider = new WebviewHost(context, CFG_SECTION, logger, monitor, activity, autoRun, autoClicker);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lakeburner-view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  monitor.start(context, () => provider.broadcastProviders());
  context.subscriptions.push(activity.onChange(() => provider.broadcastActivity()));
  context.subscriptions.push(autoRun.onChange(() => provider.broadcastAutoRun()));

  registerLakeBurnerParticipant(context, logger, activity, autoRun, CFG_SECTION);
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
    vscode.commands.registerCommand("lakeburner.autoClick.calibrate", () => autoClicker.calibrateFallbackPosition())
  );

  logger.info({ fn: "activate" }, "LakeBurner Ready", { autoRun: autoRun.isEnabled });
}

export function deactivate() {}

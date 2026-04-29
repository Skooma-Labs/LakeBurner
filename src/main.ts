import * as vscode from "vscode";
import { WebviewHost } from "./frontend/ts/HostController";
import { Logger } from "./frontend/ts/TSLogger";
import { ProviderMonitor } from "./backend/ProviderMonitor";
import { registerLakeBurnerParticipant } from "./backend/ChatParticipant";
import { ActivityLog } from "./backend/ActivityLog";

const CFG_SECTION = "lakeburner";

export function activate(context: vscode.ExtensionContext) {
  const logger = Logger.create(context, "LakeBurner", CFG_SECTION, "main.ts");

  logger.info({ fn: "activate" }, "Extension Activation Started", { debugLevel: logger.getLevel() });

  const activity = new ActivityLog(logger);
  const monitor = new ProviderMonitor(logger, CFG_SECTION);
  const provider = new WebviewHost(context, CFG_SECTION, logger, monitor, activity);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lakeburner-view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  monitor.start(context, () => provider.broadcastProviders());
  context.subscriptions.push(activity.onChange(() => provider.broadcastActivity()));

  registerLakeBurnerParticipant(context, logger, activity, CFG_SECTION);

  logger.info({ fn: "activate" }, "LakeBurner Ready");
}

export function deactivate() {}

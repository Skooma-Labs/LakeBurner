import * as vscode from "vscode";
import { WebviewHost } from "./frontend/ts/HostController";
import { Logger } from "./frontend/ts/TSLogger";

const MODE_KEY = "vscplate.currentMode";
const CFG_SECTION = "vscplate";

export function activate(context: vscode.ExtensionContext) {
  const logger = Logger.create(context, "VscPlate", CFG_SECTION, "main.ts");

  logger.info({ fn: "activate" }, "Extension Activation Started", { debugLevel: logger.getLevel() });
  logger.show(true);

  const output = logger.getOutputChannel();

  const provider = new WebviewHost(context, output, CFG_SECTION, logger);
  logger.info({ fn: "activate" }, "HostController initialized");

  const webviewDisposable = vscode.window.registerWebviewViewProvider("vscplate-view", provider, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  context.subscriptions.push(webviewDisposable);
  logger.info({ fn: "activate" }, "Webview Provider Registered", { viewId: "vscplate-view" });

  const priorMode = context.globalState.get(MODE_KEY);

  if (!priorMode) {
    void context.globalState.update(MODE_KEY, "Mode_01");
    logger.info({ fn: "activate" }, "Default Mode Initialized", { modeKey: MODE_KEY, mode: "Mode_01" });
  } else {
    logger.info({ fn: "activate" }, "Existing Mode Found", { modeKey: MODE_KEY, mode: priorMode });
  }
}

export function deactivate() {}

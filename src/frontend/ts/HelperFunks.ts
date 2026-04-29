import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { type DebugLevel, Logger } from "./TSLogger";

export type VscPlateSettings = {
  url: string;
  name: string;
  folder: string;
  debugLevel: DebugLevel;
};

function isDebugLevel(v: unknown): v is DebugLevel {
  return v === "Silent" || v === "Basic" || v === "Loud";
}

export function readVscPlateSettings(cfgSection: string): VscPlateSettings {
  const cfg = vscode.workspace.getConfiguration(cfgSection);

  const url = String(cfg.get("url", "")).trim();
  const name = String(cfg.get("name", "")).trim();
  const folder = String(cfg.get("folder", "")).trim();

  const raw = cfg.get("debugLevel");
  if (!isDebugLevel(raw)) throw new Error(`Invalid setting: ${cfgSection}.debugLevel (expected: Silent|Basic|Loud)`);

  return { url, name, folder, debugLevel: raw };
}

export async function writeVscPlateSetting(
  cfgSection: string,
  key: "url" | "name" | "folder" | "debugLevel",
  value: string,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(cfgSection);
  await cfg.update(key, value, target);
}

export async function runWithUiErrorHandling<T>(
  output: vscode.OutputChannel,
  actionLabel: string,
  fn: () => Promise<T>,
  logger?: Pick<Logger, "task" | "error">
): Promise<T | undefined> {
  try {
    output.show(true);
    logger?.task({ fn: "runWithUiErrorHandling" }, "begin", { action: actionLabel });

    const result = await fn();

    logger?.task({ fn: "runWithUiErrorHandling" }, "ok", { action: actionLabel });
    return result;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    logger?.error({ fn: "runWithUiErrorHandling" }, "failed", { action: actionLabel, reason, stack });
    output.appendLine(`[UI][ERROR] ${actionLabel} failed: ${reason}`);
    vscode.window.showErrorMessage(`VscPlate: ${actionLabel} failed. See Output → VscPlate.`);
    return undefined;
  }
}

export async function promptForInputId(): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title: "VscPlate",
    prompt: "Enter an Input ID",
    placeHolder: "e.g. 123456",
    ignoreFocusOut: true,
    validateInput: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return "Input ID is required.";
      return null;
    },
  });

  if (!raw) return undefined;
  return raw.trim();
}

export const WorkingDirectory = {
  async ensureExists(pathToDirectory: string): Promise<void> {
    await fs.promises.mkdir(pathToDirectory, { recursive: true });
  },

  resolveFromUserSelection(folder: string): string {
    const pickedFolder = String(folder ?? "").trim();
    if (!pickedFolder) throw new Error("Set Folder is required. Pick a folder and Save.");

    const leafFolderName = path.basename(pickedFolder).toLowerCase();
    if (leafFolderName === "vscplate") {
      throw new Error("Set Folder must be the parent directory. Do not select the VscPlate folder itself.");
    }

    return path.join(pickedFolder, "VscPlate");
  },
};

export async function ensureDir(dirPath: string): Promise<void> {
  return WorkingDirectory.ensureExists(dirPath);
}

export function resolveWorkingDir(folder: string): string {
  return WorkingDirectory.resolveFromUserSelection(folder);
}

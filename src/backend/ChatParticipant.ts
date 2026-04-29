import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";
import type { ActivityLog } from "./ActivityLog";
import type { AutoRunMode } from "./AutoRunMode";

const PARTICIPANT_ID = "lakeburner.harness";

type LakeBurnerCommand = "approve" | "context" | "advise" | undefined;

/**
 * Registers the @lakeburner chat participant.
 *
 * Acts as a "User-Approval Harness" alongside Copilot:
 *   - @lakeburner approve <action>   → asks the user to confirm; defaults to the safest path on cancel.
 *   - @lakeburner context <topic>    → returns whatever local context LakeBurner can describe.
 *   - @lakeburner advise <plan>      → returns the safest direction to take.
 *
 * With no command, falls through to a generic safe-direction recommendation.
 */
export function registerLakeBurnerParticipant(
  context: vscode.ExtensionContext,
  logger: Logger,
  activity: ActivityLog,
  autoRun: AutoRunMode,
  cfgSection: string
): void {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== "function") {
    logger.warn({ fn: "registerLakeBurnerParticipant" }, "Chat API Unavailable; Skipping Participant Registration");
    return;
  }

  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const command = (request.command as LakeBurnerCommand) ?? undefined;
    const prompt = (request.prompt ?? "").trim();

    activity.add("REQUEST", `@lakeburner ${command ?? ""} ${prompt}`.trim(), {
      command,
      promptLength: prompt.length,
    });

    if (token.isCancellationRequested) return { metadata: { cancelled: true } };

    switch (command) {
      case "approve":
        return await handleApprove(prompt, stream, activity, autoRun);

      case "context":
        return await handleContext(prompt, stream, activity, cfgSection);

      case "advise":
      default:
        return await handleAdvise(prompt, stream, activity, autoRun);
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "flame-icon.png");

  context.subscriptions.push(participant);

  logger.info({ fn: "registerLakeBurnerParticipant" }, "Chat Participant Registered", { id: PARTICIPANT_ID });
}

async function handleApprove(
  prompt: string,
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  autoRun: AutoRunMode
): Promise<vscode.ChatResult> {
  const action = prompt || "the proposed action";

  stream.markdown(`**LakeBurner — Approval Harness**\n\nRequesting user approval for: \`${action}\`\n\n`);

  if (autoRun.isEnabled) {
    activity.add("APPROVE", `Auto-approved: ${action}`, { source: "chat-participant", auto: true });
    stream.markdown(`⚡ **Auto-approved.** Auto-Run is ON — proceed with \`${action}\`.\n`);
    return { metadata: { decision: "approve", auto: true } };
  }

  const choice = await vscode.window.showInformationMessage(
    `LakeBurner is requesting approval for: ${action}`,
    { modal: false },
    "Approve",
    "Block"
  );

  if (choice === "Approve") {
    activity.add("APPROVE", `User approved: ${action}`);
    stream.markdown(`✅ **Approved.** Copilot may proceed with \`${action}\`.\n`);
    return { metadata: { decision: "approve" } };
  }

  // Default to the safest direction on cancel or block.
  activity.add("BLOCK", `User blocked (or did not approve): ${action}`);
  stream.markdown(
    `🛑 **Blocked.** LakeBurner defaults to the **safest direction**: do not perform \`${action}\` without explicit user instruction.\n`
  );
  return { metadata: { decision: "block" } };
}

async function handleContext(
  prompt: string,
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  cfgSection: string
): Promise<vscode.ChatResult> {
  const topic = prompt || "general workspace context";

  const wsFolders = vscode.workspace.workspaceFolders ?? [];
  const activeEditor = vscode.window.activeTextEditor;
  const cfg = vscode.workspace.getConfiguration(cfgSection);

  stream.markdown(`**LakeBurner — Context Reply**\n\nTopic: \`${topic}\`\n\n`);
  stream.markdown(`- Workspace folders: ${wsFolders.length}\n`);
  if (wsFolders[0]) stream.markdown(`- Primary folder: \`${wsFolders[0].uri.fsPath}\`\n`);
  if (activeEditor) {
    stream.markdown(`- Active file: \`${activeEditor.document.fileName}\`\n`);
    stream.markdown(`- Language: \`${activeEditor.document.languageId}\`\n`);
  }
  stream.markdown(`- Debug level: \`${cfg.get("debugLevel", "Basic")}\`\n`);

  activity.add("INFO", `Context delivered: ${topic}`);
  return { metadata: { topic } };
}

async function handleAdvise(
  prompt: string,
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  autoRun: AutoRunMode
): Promise<vscode.ChatResult> {
  const plan = prompt || "(no plan provided)";

  if (autoRun.isEnabled) {
    stream.markdown(`**LakeBurner — Auto-Run Direction**\n\n> ${autoRun.trustPhrase}\n`);
    activity.add("APPROVE", `Auto-direction: ${autoRun.trustPhrase}`, { plan, source: "chat-participant", auto: true });
    return { metadata: { decision: "trust", auto: true } };
  }

  stream.markdown(`**LakeBurner — Safe-Direction Advisor**\n\n`);
  stream.markdown(`Proposed plan: \`${plan}\`\n\n`);
  stream.markdown(
    `LakeBurner's recommendation: take the **smallest reversible step first** and request user approval before any action that:\n` +
      `- Modifies files outside the active editor\n` +
      `- Writes to disk, the network, or shared infrastructure\n` +
      `- Cannot be undone by a single \`Ctrl+Z\` or \`git reset --hard HEAD\`\n\n` +
      `Use \`@lakeburner approve <action>\` to gate any of the above.\n`
  );

  activity.add("INFO", `Advice issued for plan: ${plan}`);
  return { metadata: { plan } };
}

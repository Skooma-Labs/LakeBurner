import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";
import type { ActivityLog } from "./ActivityLog";
import type { AutoRunMode } from "./AutoRunMode";
import type { AffectedChats } from "./AffectedChats";

const PARTICIPANT_ID = "lakeburner.harness";

type LakeBurnerCommand = "approve" | "context" | "advise" | "start" | "stop" | undefined;

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
  cfgSection: string,
  affected: AffectedChats
): void {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== "function") {
    logger.warn({ fn: "registerLakeBurnerParticipant" }, "Chat API Unavailable; Skipping Participant Registration");
    return;
  }

  const handler: vscode.ChatRequestHandler = async (request, ctx, stream, token) => {
    let command = (request.command as LakeBurnerCommand) ?? undefined;
    const prompt = (request.prompt ?? "").trim();

    // Allow bare "start" / "stop" (case-insensitive) as the prompt to mean
    // the same thing as the /start /stop subcommands. Lets the user type
    // "@lakeburner start" naturally without selecting a subcommand pill.
    if (!command) {
      const firstWord = prompt.split(/\s+/)[0]?.toLowerCase();
      if (firstWord === "start" || firstWord === "stop") {
        command = firstWord;
      }
    }

    // Find the conversation's first user prompt (used for stable session ID).
    let firstPrompt = prompt;
    const history = (ctx?.history ?? []) as readonly vscode.ChatRequestTurn[];
    for (const turn of history) {
      const turnPrompt = (turn as { prompt?: string }).prompt;
      if (typeof turnPrompt === "string" && turnPrompt.trim()) {
        firstPrompt = turnPrompt;
        break;
      }
    }
    const sessionId = affected.registerTurn(firstPrompt, prompt);

    activity.add("REQUEST", `@lakeburner ${command ?? ""} ${prompt}`.trim(), {
      command,
      promptLength: prompt.length,
      sessionId,
    });

    if (token.isCancellationRequested) return { metadata: { cancelled: true, sessionId } };

    switch (command) {
      case "approve":
        return await handleApprove(prompt, stream, activity, autoRun, sessionId);

      case "context":
        return await handleContext(prompt, stream, activity, cfgSection, sessionId);

      case "start":
        return await handleStart(stream, activity, affected, autoRun, sessionId);

      case "stop":
        return await handleStop(stream, activity, affected, sessionId);

      case "advise":
      default:
        return await handleAdvise(prompt, stream, activity, autoRun, sessionId);
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
  autoRun: AutoRunMode,
  sessionId: string
): Promise<vscode.ChatResult> {
  const action = prompt || "the proposed action";

  stream.markdown(`**LakeBurner — Approval Harness**\n\nRequesting user approval for: \`${action}\`\n\n`);

  if (autoRun.isEnabled) {
    activity.add("APPROVE", `Auto-approved: ${action}`, { source: "chat-participant", auto: true, sessionId });
    stream.markdown(`⚡ **Auto-approved.** Auto-Run is ON — proceed with \`${action}\`.\n`);
    return { metadata: { decision: "approve", auto: true, sessionId } };
  }

  const choice = await vscode.window.showInformationMessage(
    `LakeBurner is requesting approval for: ${action}`,
    { modal: false },
    "Approve",
    "Block"
  );

  if (choice === "Approve") {
    activity.add("APPROVE", `User approved: ${action}`, { sessionId });
    stream.markdown(`✅ **Approved.** Copilot may proceed with \`${action}\`.\n`);
    return { metadata: { decision: "approve", sessionId } };
  }

  // Default to the safest direction on cancel or block.
  activity.add("BLOCK", `User blocked (or did not approve): ${action}`, { sessionId });
  stream.markdown(
    `🛑 **Blocked.** LakeBurner defaults to the **safest direction**: do not perform \`${action}\` without explicit user instruction.\n`
  );
  return { metadata: { decision: "block", sessionId } };
}

async function handleContext(
  prompt: string,
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  cfgSection: string,
  sessionId: string
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
  stream.markdown(`- Debug level: \`${cfg.get("debugLevel", "Quiet")}\`\n`);

  activity.add("INFO", `Context delivered: ${topic}`, { sessionId });
  return { metadata: { topic, sessionId } };
}

async function handleAdvise(
  prompt: string,
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  autoRun: AutoRunMode,
  sessionId: string
): Promise<vscode.ChatResult> {
  const plan = prompt || "(no plan provided)";

  if (autoRun.isEnabled) {
    stream.markdown(`**LakeBurner — Auto-Run Direction**\n\n> ${autoRun.trustPhrase}\n`);
    activity.add("APPROVE", `Auto-direction: ${autoRun.trustPhrase}`, { plan, source: "chat-participant", auto: true, sessionId });
    return { metadata: { decision: "trust", auto: true, sessionId } };
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

  activity.add("INFO", `Advice issued for plan: ${plan}`, { sessionId });
  return { metadata: { plan, sessionId } };
}

async function handleStart(
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  affected: AffectedChats,
  autoRun: AutoRunMode,
  sessionId: string
): Promise<vscode.ChatResult> {
  // Ensure the current session is allow-listed (auto-allow normally handles
  // this on first turn, but `start` is the explicit opt-in either way).
  await affected.setAllowed(sessionId, true);

  const autoRunNote = autoRun.isEnabled
    ? "Auto-Run is **ON** \u2014 Allow / Keep dialogs in this chat will be pressed automatically."
    : "Auto-Run is currently **OFF** \u2014 turn it on in the LakeBurner sidebar to actually press anything.";

  stream.markdown(
    `**LakeBurner \u2014 Session Armed**\n\n` +
      `This chat session is now in the **Affected Chats** list. ${autoRunNote}\n\n` +
      `Send \`@lakeburner stop\` in this chat at any time to remove it.\n`
  );
  activity.add("APPROVE", `Auto-Run armed via @lakeburner start`, { sessionId });
  return { metadata: { armed: true, sessionId } };
}

async function handleStop(
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  affected: AffectedChats,
  sessionId: string
): Promise<vscode.ChatResult> {
  await affected.removeSession(sessionId);
  stream.markdown(
    `**LakeBurner \u2014 Session Disarmed**\n\nRemoved from the Affected Chats list. Auto-Run will no longer press Allow / Keep on behalf of this chat.\n`
  );
  activity.add("BLOCK", "Auto-Run disarmed via @lakeburner stop", { sessionId });
  return { metadata: { armed: false, sessionId } };
}

import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";
import type { ActivityLog } from "./ActivityLog";
import type { AutoRunMode } from "./AutoRunMode";
import type { AffectedChats } from "./AffectedChats";
import type { PromptDispatcher } from "./PromptDispatcher";

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
  affected: AffectedChats,
  dispatcher?: PromptDispatcher
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
    const sessionId =
      command === "start"
        ? await affected.igniteTurn(firstPrompt, prompt)
        : await affected.noteTurn(firstPrompt, prompt);

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
        return await handleStart(stream, activity, autoRun, sessionId);

      case "stop":
        return await handleStop(stream, activity, affected, autoRun, sessionId);

      case "advise":
      default:
        return await handleAdvise(prompt, stream, activity, autoRun, sessionId, dispatcher);
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
  sessionId: string,
  dispatcher?: PromptDispatcher
): Promise<vscode.ChatResult> {
  // When the user just invokes @lakeburner (with or without text), prompt them
  // for what they'd like LakeBurner to continue the conversation with, then
  // dispatch that prompt into the active chat target.
  stream.markdown(`**LakeBurner — Continue Chat**\n\n`);

  // If the user provided text alongside the @lakeburner mention, use it as the prompt.
  let continuePrompt = prompt;

  if (!continuePrompt) {
    // Ask the user what they'd like LakeBurner to continue with.
    const input = await vscode.window.showInputBox({
      title: "LakeBurner: Continue Chat",
      prompt: "What prompt should LakeBurner continue this conversation with?",
      placeHolder: "e.g. Keep going, improve the output quality...",
      ignoreFocusOut: true,
    });
    if (!input || !input.trim()) {
      stream.markdown(`No prompt provided — LakeBurner will not dispatch.\n`);
      activity.add("INFO", "Continue prompt cancelled by user", { sessionId });
      return { metadata: { decision: "cancelled", sessionId } };
    }
    continuePrompt = input.trim();
  }

  // The request already registered this conversation as an Active Fire.
  activity.add("REQUEST", `Continue: ${continuePrompt}`, { sessionId, length: continuePrompt.length });

  if (dispatcher) {
    // Pick the first available target (default is Copilot Chat agent mode).
    const targets = dispatcher.listTargets();
    const target = targets.find((t) => t.id === "copilot") ?? targets[0];
    if (target) {
      stream.markdown(`Dispatching to **${target.label}**:\n> ${continuePrompt}\n`);
      await dispatcher.send(target.id, continuePrompt);
      activity.add("APPROVE", `Dispatched continue prompt → ${target.label}`, { sessionId, targetId: target.id });
      return { metadata: { decision: "dispatched", sessionId, targetId: target.id } };
    }
  }

  // Fallback: no dispatcher or no targets — just echo the trust phrase.
  stream.markdown(`> ${autoRun.trustPhrase}\n`);
  activity.add("APPROVE", `Auto-direction: ${autoRun.trustPhrase}`, { sessionId, auto: true });
  return { metadata: { decision: "trust", auto: true, sessionId } };
}

async function handleStart(
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  autoRun: AutoRunMode,
  sessionId: string
): Promise<vscode.ChatResult> {
  // `igniteTurn` already registered this conversation before we reached the
  // command handler. Turning Auto-Run on here mirrors Start a Chat, but keeps
  // the current chat as the active fire.
  await autoRun.setEnabled(true);

  stream.markdown(
    `**LakeBurner \u2014 Session Armed**\n\n` +
      `This chat session is now in **Active Fires**. Auto-Run is **ON** \u2014 Allow / Keep dialogs will be pressed automatically and Keep Going prompts will begin after idle windows.\n\n` +
      `Send \`@lakeburner stop\` in this chat at any time to remove it.\n`
  );
  activity.add("APPROVE", `Active Fire ignited via @lakeburner start`, { sessionId });
  return { metadata: { armed: true, sessionId } };
}

async function handleStop(
  stream: vscode.ChatResponseStream,
  activity: ActivityLog,
  affected: AffectedChats,
  autoRun: AutoRunMode,
  sessionId: string
): Promise<vscode.ChatResult> {
  await autoRun.setEnabled(false);
  await affected.clear();
  stream.markdown(
    `**LakeBurner \u2014 Extinguished**\n\nAuto-Run is **OFF** and all Active Fires have been cleared. LakeBurner will no longer press Allow / Keep or send Keep Going prompts until you start it again.\n`
  );
  activity.add("BLOCK", "Auto-Run extinguished via @lakeburner stop", { sessionId });
  return { metadata: { armed: false, sessionId } };
}

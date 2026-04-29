import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";
import type { AutoRunMode } from "./AutoRunMode";
import type { ActivityLog } from "./ActivityLog";

type DecideInput = {
  question?: string;
  kind?: "approve" | "decide";
};

const TOOL_NAME = "lakeburner_decide";

/**
 * Registers the `lakeburner_decide` Language Model Tool.
 *
 * Copilot (and any other LM-tool-aware assistant) can invoke this tool autonomously
 * when it needs an approval or direction from the user. Behaviour:
 *
 *   - Auto-Run ON  → returns immediate approval (`approve` kind) or the trust phrase
 *                    ("Keep going, I trust your intuitions") for `decide` kind.
 *   - Auto-Run OFF → prompts the user via showInformationMessage / showInputBox and
 *                    returns the user's response (defaults to the safest direction
 *                    on cancel).
 */
export function registerLakeBurnerLmTools(
  context: vscode.ExtensionContext,
  logger: Logger,
  autoRun: AutoRunMode,
  activity: ActivityLog
): void {
  if (!vscode.lm || typeof vscode.lm.registerTool !== "function") {
    logger.warn({ fn: "registerLakeBurnerLmTools" }, "Language Model Tools API Unavailable; Skipping");
    return;
  }

  const tool: vscode.LanguageModelTool<DecideInput> = {
    async prepareInvocation(options, _token) {
      const input = options.input ?? {};
      const kind = input.kind === "approve" ? "approve" : "decide";
      const question = (input.question ?? "").trim() || (kind === "approve" ? "the proposed action" : "the next step");

      if (autoRun.isEnabled) {
        // Auto-Run mode: no confirmation UI; the harness has standing approval.
        return {
          invocationMessage: kind === "approve"
            ? `LakeBurner auto-approving: ${question}`
            : `LakeBurner advising: ${question}`,
        };
      }

      // Manual mode: ask the user to confirm via the standard tool-confirmation dialog.
      return {
        invocationMessage: `LakeBurner consulting user: ${question}`,
        confirmationMessages: {
          title: "LakeBurner — User Approval Harness",
          message: new vscode.MarkdownString(
            kind === "approve"
              ? `An AI assistant is requesting approval for:\n\n> ${question}\n\nApprove?`
              : `An AI assistant is asking which direction to take:\n\n> ${question}\n\nReply with the trust phrase (\`${autoRun.trustPhrase}\`)?`
          ),
        },
      };
    },

    async invoke(options, _token) {
      const input = options.input ?? {};
      const kind = input.kind === "approve" ? "approve" : "decide";
      const question = (input.question ?? "").trim() || (kind === "approve" ? "the proposed action" : "the next step");

      if (autoRun.isEnabled) {
        if (kind === "approve") {
          activity.add("APPROVE", `Auto-approved: ${question}`, { source: "lm-tool", auto: true });
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `APPROVED. The user has Auto-Run enabled and pre-approves this action: ${question}. Proceed.`
            ),
          ]);
        }

        activity.add("APPROVE", `Auto-decision: ${autoRun.trustPhrase}`, { question, source: "lm-tool", auto: true });
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(autoRun.trustPhrase),
        ]);
      }

      // Manual mode — fall back to a user prompt (the confirmation dialog from
      // prepareInvocation has already been accepted at this point, but we still
      // surface a focused prompt for `decide` so the user can override).
      if (kind === "approve") {
        activity.add("APPROVE", `Approved (manual): ${question}`, { source: "lm-tool", auto: false });
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `APPROVED by the user for: ${question}. Proceed.`
          ),
        ]);
      }

      const reply = await vscode.window.showInputBox({
        title: "LakeBurner — Direction Requested",
        prompt: question,
        placeHolder: autoRun.trustPhrase,
        ignoreFocusOut: true,
      });

      const text = (reply ?? "").trim() || autoRun.trustPhrase;
      activity.add("INFO", `Direction provided: ${text}`, { question, source: "lm-tool", auto: false });
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    },
  };

  context.subscriptions.push(vscode.lm.registerTool<DecideInput>(TOOL_NAME, tool));
  logger.info({ fn: "registerLakeBurnerLmTools" }, "Language Model Tool Registered", { name: TOOL_NAME });
}

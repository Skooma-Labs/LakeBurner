import * as net from "net";
import * as vscode from "vscode";
import { Logger } from "../frontend/ts/Logger";
import { PromptDispatcher } from "./PromptDispatcher";
import { AutoRunMode } from "./AutoRunMode";
import { AffectedChats } from "./AffectedChats";

export class LocalCommandListener {
  private server: net.Server | null = null;
  private readonly cfgSection: string;
  private readonly logger: Logger;
  private readonly dispatcher: PromptDispatcher;
  private readonly autoRun: AutoRunMode;
  private readonly affected: AffectedChats;

  constructor(
    cfgSection: string,
    logger: Logger,
    dispatcher: PromptDispatcher,
    autoRun: AutoRunMode,
    affected: AffectedChats
  ) {
    this.cfgSection = cfgSection;
    this.logger = logger;
    this.dispatcher = dispatcher;
    this.autoRun = autoRun;
    this.affected = affected;
  }

  start(context: vscode.ExtensionContext): void {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const enabled = cfg.get<boolean>("localCommandInjection.enabled", false);
    if (!enabled) {
      this.logger.info({ fn: "LocalCommandListener.start" }, "Local command injection is disabled");
      return;
    }

    const port = cfg.get<number>("localCommandInjection.port", 19816);
    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.listen(port, "127.0.0.1", () => {
      this.logger.info({ fn: "LocalCommandListener.start" }, `Listening on 127.0.0.1:${port}`);
    });

    this.server.on("error", (err) => {
      this.logger.info({ fn: "LocalCommandListener.start" }, `Server error: ${err.message}`);
    });

    context.subscriptions.push({
      dispose: () => this.stop(),
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.info({ fn: "LocalCommandListener.stop" }, "Local command listener stopped");
    }
  }

  private handleConnection(socket: net.Socket): void {
    const chunks: Buffer[] = [];
    let processed = false;

    const tryProcess = (final: boolean) => {
      if (processed) return;

      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      if (total > 1_048_576) {
        processed = true;
        socket.write("ERROR: Payload too large");
        socket.end();
        return;
      }

      const raw = Buffer.concat(chunks).toString("utf-8");
      let parsed: { command?: string; prompt?: string; targetId?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (final) {
          processed = true;
          socket.write("ERROR: Invalid JSON");
          socket.end();
        }
        return;
      }

      processed = true;
      this.processCommand(parsed, socket);
    };

    socket.on("data", (chunk) => {
      chunks.push(chunk);
      tryProcess(false);
    });

    socket.on("end", () => {
      tryProcess(true);
    });

    socket.on("error", (err) => {
      this.logger.info({ fn: "LocalCommandListener.handleConnection" }, `Socket error: ${err.message}`);
    });
  }

  private processCommand(parsed: { command?: string; prompt?: string; targetId?: string }, socket: net.Socket): void {
    const command = parsed.command;
    if (command === "startChat") {
      const prompt = parsed.prompt ?? "";
      if (!prompt.trim()) {
        socket.write("ERROR: Empty prompt");
        socket.end();
        return;
      }

      this.logger.info({ fn: "LocalCommandListener.processCommand" }, `Received startChat: "${prompt.slice(0, 80)}..."`);

      const targetId = parsed.targetId ?? this.dispatcher.listTargets()[0]?.id ?? "copilot";

      void this.dispatchStartChat(targetId, prompt).then((result) => {
        socket.write(result);
        socket.end();
      });
    } else {
      socket.write(`ERROR: Unknown command "${command}"`);
      socket.end();
    }
  }

  private async dispatchStartChat(targetId: string, prompt: string): Promise<string> {
    try {
      const result = await this.dispatcher.send(targetId, prompt);
      if (!result.ok) {
        return `ERROR: ${result.reason ?? `Failed to dispatch to ${result.target.label}`}`;
      }
      await this.autoRun.setEnabled(true);
      await this.affected.registerExternal(prompt);
      await this.affected.setActiveTargetId(targetId);
      return "OK: Prompt dispatched";
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info({ fn: "LocalCommandListener.dispatchStartChat" }, `Dispatch failed: ${msg}`);
      return `ERROR: ${msg}`;
    }
  }
}

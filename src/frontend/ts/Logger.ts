import type * as vscode from "vscode";

// ------------------
// Types
// ------------------

export type DebugLevel = "Silent" | "Quiet" | "Loud";
export type LogKind = "TASK" | "USER" | "INFO" | "WARN" | "ERROR";

export type LogSource = {
  file: string;
  fn: string;
};

export type HostLogEnvelope = {
  type: "lakeburner.hostlog";
  kind: LogKind;
  file: string;
  fn: string;
  message: string;
  data?: unknown;
};

// ------------------
// Logging Contract
// ------------------
//
// Log Line Shape:
//
//   [UtcTimestamp][FileName][FunctionName][Kind][Context] Message
//
// Rules:
// - All structured metadata lives in square brackets.
// - Message is always the final segment and MUST NOT be bracketed.
// - Context is optional, JSON-serialized, and MUST be bracketed.
// - Context is for structured facts (ids, inputs, derived values, results, evidence, durations, errors),
//   never for narration, redundancy, or pre-formatted prose.
//
// DebugLevel expectations:
// - Silent: No output whatsoever.
// - Quiet: Step progress only (TASK). Minimal signal for watching workflow progression.
// - Loud: Steps AND detailed information — full verbose diagnostics ("kitchen sink").
//
// Kind guidance (to support QA + readability):
// - USER: direct user-initiated actions (clicks, toggles, save, open dialog, confirmations).
// - TASK: system actions that advance or complete a user-visible workflow (start, progress milestones, completion).
// - WARN: unexpected but recoverable conditions.
// - ERROR: failures that prevent completion.
// - INFO: detailed diagnostics intended for Loud only (plumbing, probes, internal values, resolved paths).
//
// Examples:
//   [2026-01-12T04:24:18.517Z][HostController.ts][saveSettings][TASK][{"inputId":"42"}] User saved connection settings from the UI
//   [2026-01-12T04:24:58.772Z][HostController.ts][runTask][ERROR][{"status":401}] API rejected the request
//


// ------------------
// Utilities
// ------------------

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) {
      const cause = (v as any).cause;
      const norm = {
        name: v.name,
        message: v.message,
        stack: v.stack,
        cause:
          cause instanceof Error
            ? { name: cause.name, message: cause.message, stack: cause.stack }
            : cause === undefined
              ? undefined
              : cause,
      };
      return JSON.stringify(norm);
    }
    return JSON.stringify(v);
  } catch {
    try {
      return JSON.stringify(String(v));
    } catch {
      return "[unserializable]";
    }
  }
}

function shouldLog(level: DebugLevel, kind: LogKind): boolean {
  if (level === "Silent") return false;
  if (level === "Quiet") return kind === "TASK";
  return true;
}

function assertDebugLevel(v: unknown, settingPath: string): DebugLevel {
  if (v === "Silent" || v === "Quiet" || v === "Loud") return v;
  throw new Error(`Invalid setting: ${settingPath} (expected: Silent|Quiet|Loud)`);
}

function utcIso(): string {
  return new Date().toISOString();
}

function formatContext(data?: unknown): string {
  if (data === undefined) return "";
  const j = safeJson(data);

  if (j === undefined || j === null) return "";
  const s = String(j);

  if (s === "" || s === "undefined") return "";
  return s;
}

function formatLogLine(
  tsUtcIso: string,
  file: string,
  fn: string,
  kind: LogKind,
  message: string,
  data?: unknown
): string {
  const ctx = formatContext(data);
  const ctxBracket = ctx ? `[${ctx}]` : "";
  return `[${tsUtcIso}][${file}][${fn}][${kind}]${ctxBracket} ${message}`;
}

type RawConsole = {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

// ------------------
// Host Logger (Extension Host)
// ------------------

export class Logger {
  private readonly output: vscode.OutputChannel;
  private readonly cfgSection: string;
  private readonly fileName: string;
  private level: DebugLevel;

  constructor(output: vscode.OutputChannel, cfgSection: string, fileName: string) {
    this.output = output;
    this.cfgSection = cfgSection;
    this.fileName = fileName;
    this.level = this.readLevel();
  }

  public static create(
    context: vscode.ExtensionContext,
    channelName: string,
    cfgSection: string,
    fileName: string = "extension"
  ): Logger {
    const vs = require("vscode") as typeof import("vscode");

    const output = vs.window.createOutputChannel(channelName);
    const logger = new Logger(output, cfgSection, fileName);

    context.subscriptions.push(
      vs.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${cfgSection}.debugLevel`)) {
          logger.reloadLevel();
        }
      })
    );

    return logger;
  }

  public getOutputChannel(): vscode.OutputChannel {
    return this.output;
  }

  public getLevel(): DebugLevel {
    return this.level;
  }

  public refresh(): DebugLevel {
    this.reloadLevel();
    return this.level;
  }

  public reloadLevel(): void {
    const prev = this.level;
    this.level = this.readLevel();
    if (prev !== this.level) {
      this.task({ fn: "reloadLevel" }, "DebugLevel changed", { from: prev, to: this.level });
    }
  }

  private readLevel(): DebugLevel {
    const vs = require("vscode") as typeof import("vscode");

    const cfg = vs.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get("debugLevel");

    if (raw === undefined || raw === null) {
      throw new Error(`Missing setting: ${this.cfgSection}.debugLevel`);
    }

    return assertDebugLevel(raw, `${this.cfgSection}.debugLevel`);
  }

  private write(kind: LogKind, src: LogSource, msg: string, data?: unknown): void {
    if (!shouldLog(this.level, kind)) return;
    const line = formatLogLine(utcIso(), this.fileName, src.fn, kind, msg, data);
    this.output.appendLine(line);
  }

  public show(preserveFocus: boolean = true): void {
    this.output.show(preserveFocus);
  }

  public task(src: Partial<LogSource>, msg: string, data?: unknown): void {
    this.write("TASK", { file: this.fileName, fn: src.fn ?? "task" }, msg, data);
  }

  public user(src: Partial<LogSource>, msg: string, data?: unknown): void {
    this.write("USER", { file: this.fileName, fn: src.fn ?? "user" }, msg, data);
  }

  public info(src: Partial<LogSource>, msg: string, data?: unknown): void {
    this.write("INFO", { file: this.fileName, fn: src.fn ?? "info" }, msg, data);
  }

  public warn(src: Partial<LogSource>, msg: string, data?: unknown): void {
    this.write("WARN", { file: this.fileName, fn: src.fn ?? "warn" }, msg, data);
  }

  public error(src: Partial<LogSource>, msg: string, data?: unknown): void {
    this.write("ERROR", { file: this.fileName, fn: src.fn ?? "error" }, msg, data);
  }
}

// ------------------
// Webview Logger
// ------------------

export type WebviewLogger = {
  getLevel(): DebugLevel;
  setLevel(next: DebugLevel): boolean;

  task(fn: string, msg: string, data?: unknown): void;
  user(fn: string, msg: string, data?: unknown): void;
  info(fn: string, msg: string, data?: unknown): void;
  warn(fn: string, msg: string, data?: unknown): void;
  error(fn: string, msg: string, data?: unknown): void;

  installConsoleForwarding(): void;
};

export function createWebviewLogger(opts: {
  postMessage: (msg: HostLogEnvelope) => void;
  fileName?: string;
}): WebviewLogger {
  let level: DebugLevel = "Silent";
  let consoleForwardingInstalled = false;

  const file = opts.fileName ?? "webview.ts";

  const rawConsole: RawConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const kindColors: Record<LogKind, string> = {
    TASK: "color:#22c55e;font-weight:bold",   // green
    USER: "color:#3b82f6;font-weight:bold",   // blue
    INFO: "color:#a3a3a3",                    // gray
    WARN: "color:#eab308;font-weight:bold",   // yellow
    ERROR: "color:#ef4444;font-weight:bold",  // red
  };
  const fileColor = "color:#c084fc";           // purple
  const resetStyle = "color:inherit;font-weight:normal";

  function emit(kind: LogKind, fn: string, message: string, data?: unknown): void {
    if (!shouldLog(level, kind)) return;

    const ts = utcIso();
    const ctx = formatContext(data);
    const ctxBracket = ctx ? `[${ctx}]` : "";

    // Color-coded console output: [timestamp][%cfile%c][fn][%ckind%c][ctx] message
    const template = `[${ts}][%c${file}%c][${fn}][%c${kind}%c]${ctxBracket} ${message}`;
    const styles = [fileColor, resetStyle, kindColors[kind], resetStyle];

    if (kind === "ERROR") rawConsole.error(template, ...styles);
    else if (kind === "WARN") rawConsole.warn(template, ...styles);
    else rawConsole.info(template, ...styles);

    try {
      opts.postMessage({ type: "lakeburner.hostlog", kind, file, fn, message, data });
    } catch {}
  }

  function setLevel(next: DebugLevel): boolean {
    const prev = level;
    level = next;
    return prev !== next;
  }

  function installConsoleForwarding(): void {
    if (consoleForwardingInstalled) return;
    if (level !== "Loud") return;

    consoleForwardingInstalled = true;

    const wrap = (methodName: keyof RawConsole, kind: LogKind) => {
      const original = rawConsole[methodName];
      (console as any)[methodName] = (...args: unknown[]) => {
        original(...args);
        emit(kind, "console", String(methodName), { args });
      };
    };

    wrap("log", "INFO");
    wrap("debug", "INFO");
    wrap("info", "INFO");
    wrap("warn", "WARN");
    wrap("error", "ERROR");

    window.addEventListener("error", (event) => {
      emit("ERROR", "window.error", "error", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    });

    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      emit("ERROR", "window.unhandledrejection", "unhandledrejection", { reason: event.reason });
    });
  }

  return {
    getLevel: () => level,
    setLevel,

    task: (fn, msg, data) => emit("TASK", fn, msg, data),
    user: (fn, msg, data) => emit("USER", fn, msg, data),
    info: (fn, msg, data) => emit("INFO", fn, msg, data),
    warn: (fn, msg, data) => emit("WARN", fn, msg, data),
    error: (fn, msg, data) => emit("ERROR", fn, msg, data),

    installConsoleForwarding,
  };
}

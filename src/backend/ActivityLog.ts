import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";

export type ActivityKind = "REQUEST" | "APPROVE" | "BLOCK" | "INFO";

export type ActivityEntry = {
  id: number;
  tsIso: string;
  kind: ActivityKind;
  message: string;
  data?: unknown;
};

const MAX_ENTRIES = 200;

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private nextId = 1;
  private readonly emitter = new vscode.EventEmitter<void>();

  constructor(private readonly logger: Logger) {}

  public readonly onChange = this.emitter.event;

  public add(kind: ActivityKind, message: string, data?: unknown): ActivityEntry {
    const entry: ActivityEntry = {
      id: this.nextId++,
      tsIso: new Date().toISOString(),
      kind,
      message,
      data,
    };

    const logData = { lakeburnerActivityId: entry.id, lakeburnerActivityKind: kind, ...normalizeData(data) };

    if (kind === "INFO") {
      this.logger.info({ fn: "ActivityLog.add" }, message, logData);
      return entry;
    }

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);

    if (kind === "REQUEST") this.logger.user({ fn: "ActivityLog.add" }, message, logData);
    else if (kind === "APPROVE") this.logger.task({ fn: "ActivityLog.add" }, message, logData);
    else this.logger.warn({ fn: "ActivityLog.add" }, message, logData);

    this.emitter.fire();
    return entry;
  }

  public list(): ActivityEntry[] {
    return this.entries.slice();
  }

  public clear(): void {
    this.entries.length = 0;
    this.emitter.fire();
  }
}

function normalizeData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : data === undefined
      ? {}
      : { data };
}

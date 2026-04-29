import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";

const STATE_KEY = "lakeburner.autoRun.enabled";
const TRUST_PHRASE = "Keep going, I trust your intuitions";

export class AutoRunMode {
  private enabled: boolean;
  private readonly emitter = new vscode.EventEmitter<boolean>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.enabled = !!context.globalState.get<boolean>(STATE_KEY, false);
  }

  public readonly onChange = this.emitter.event;

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public get trustPhrase(): string {
    return TRUST_PHRASE;
  }

  public async setEnabled(next: boolean): Promise<void> {
    if (next === this.enabled) return;
    this.enabled = next;
    await this.context.globalState.update(STATE_KEY, next);
    this.logger.user({ fn: "AutoRunMode.setEnabled" }, next ? "Auto-Run Enabled" : "Auto-Run Disabled");
    this.emitter.fire(next);
  }

  public async toggle(): Promise<boolean> {
    await this.setEnabled(!this.enabled);
    return this.enabled;
  }
}

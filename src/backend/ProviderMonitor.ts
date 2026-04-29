import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/TSLogger";

export type ProviderInfo = {
  id: string;
  label: string;
  installed: boolean;
  active: boolean;
  version?: string;
};

const DEFAULT_PROVIDERS: { id: string; label: string }[] = [
  { id: "GitHub.copilot-chat", label: "GitHub Copilot Chat" },
  { id: "anthropic.claude-code", label: "Claude Code" },
  { id: "openai.chatgpt", label: "OpenAI Codex / ChatGPT" },
];

const POLL_INTERVAL_MS = 4000;

export class ProviderMonitor {
  private timer?: NodeJS.Timeout;
  private snapshot: ProviderInfo[] = [];
  private listenerDisposable?: vscode.Disposable;

  constructor(private readonly logger: Logger, private readonly cfgSection: string) {}

  public start(context: vscode.ExtensionContext, onChange: () => void): void {
    const tick = () => {
      const next = this.computeSnapshot();
      if (this.differs(next, this.snapshot)) {
        this.snapshot = next;
        this.logger.info({ fn: "ProviderMonitor.tick" }, "Provider Snapshot Updated", {
          providers: next.map((p) => ({ id: p.id, installed: p.installed, active: p.active })),
        });
        onChange();
      }
    };

    tick();
    this.timer = setInterval(tick, POLL_INTERVAL_MS);

    this.listenerDisposable = vscode.extensions.onDidChange(() => tick());

    context.subscriptions.push({
      dispose: () => {
        if (this.timer) clearInterval(this.timer);
        this.listenerDisposable?.dispose();
      },
    });
  }

  public list(): ProviderInfo[] {
    return this.snapshot.slice();
  }

  private getConfiguredIds(): { id: string; label: string }[] {
    const cfg = vscode.workspace.getConfiguration(this.cfgSection);
    const raw = cfg.get<unknown>("providers");

    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_PROVIDERS;

    const items: { id: string; label: string }[] = [];
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) {
        items.push({ id: item.trim(), label: item.trim() });
      } else if (item && typeof item === "object") {
        const obj = item as { id?: unknown; label?: unknown };
        if (typeof obj.id === "string" && obj.id.trim()) {
          items.push({
            id: obj.id.trim(),
            label: typeof obj.label === "string" && obj.label.trim() ? obj.label.trim() : obj.id.trim(),
          });
        }
      }
    }
    return items.length > 0 ? items : DEFAULT_PROVIDERS;
  }

  private computeSnapshot(): ProviderInfo[] {
    const targets = this.getConfiguredIds();
    return targets.map(({ id, label }) => {
      const ext = vscode.extensions.getExtension(id);
      const version = ext?.packageJSON?.version as string | undefined;
      return {
        id,
        label,
        installed: !!ext,
        active: !!ext?.isActive,
        version: typeof version === "string" ? version : undefined,
      };
    });
  }

  private differs(a: ProviderInfo[], b: ProviderInfo[]): boolean {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x.id !== y.id || x.installed !== y.installed || x.active !== y.active || x.version !== y.version) return true;
    }
    return false;
  }
}

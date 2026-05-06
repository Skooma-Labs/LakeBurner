import * as vscode from "vscode";
import type { Logger } from "../frontend/ts/Logger";

export type ProviderInfo = {
  id: string;
  label: string;
  installed: boolean;
  active: boolean;
  version?: string;
  observability?: ProviderObservability;
};

export type ProviderObservability = {
  otelCapable: boolean;
  otelEnabled: boolean;
  otelEndpoint?: string;
  otelExporterType?: string;
  otelCaptureContent: boolean;
  source: "settings" | "environment" | "none";
};

const DEFAULT_PROVIDERS: { id: string; label: string }[] = [
  { id: "GitHub.copilot-chat", label: "GitHub Copilot" },
  { id: "anthropic.claude-code", label: "Claude Code" },
  { id: "openai.chatgpt", label: "OpenAI Codex" },
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
    const cfgDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${this.cfgSection}.providers`) ||
        e.affectsConfiguration("github.copilot.chat.otel.enabled") ||
        e.affectsConfiguration("github.copilot.chat.otel.exporterType") ||
        e.affectsConfiguration("github.copilot.chat.otel.otlpEndpoint") ||
        e.affectsConfiguration("github.copilot.chat.otel.captureContent") ||
        e.affectsConfiguration("github.copilot.chat.otel.outfile")
      ) {
        tick();
      }
    });

    context.subscriptions.push({
      dispose: () => {
        if (this.timer) clearInterval(this.timer);
        this.listenerDisposable?.dispose();
        cfgDisposable.dispose();
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
        observability: id.toLowerCase() === "github.copilot-chat" ? this.getCopilotObservability() : undefined,
      };
    });
  }

  private differs(a: ProviderInfo[], b: ProviderInfo[]): boolean {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (
        x.id !== y.id ||
        x.installed !== y.installed ||
        x.active !== y.active ||
        x.version !== y.version ||
        JSON.stringify(x.observability ?? null) !== JSON.stringify(y.observability ?? null)
      ) return true;
    }
    return false;
  }

  private getCopilotObservability(): ProviderObservability {
    const cfg = vscode.workspace.getConfiguration("github.copilot.chat.otel");
    const envEnabled = process.env.COPILOT_OTEL_ENABLED === "true" || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const settingEnabled = cfg.get<boolean>("enabled", false);
    const endpoint = process.env.COPILOT_OTEL_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      cfg.get<string>("otlpEndpoint", "http://localhost:4318");
    const exporterType = process.env.OTEL_EXPORTER_OTLP_PROTOCOL === "grpc"
      ? "otlp-grpc"
      : cfg.get<string>("exporterType", "otlp-http");
    const captureContent =
      process.env.COPILOT_OTEL_CAPTURE_CONTENT === "true" ||
      cfg.get<boolean>("captureContent", false);

    return {
      otelCapable: isAtLeastVersion(vscode.version, "1.119.0"),
      otelEnabled: envEnabled || settingEnabled,
      otelEndpoint: endpoint,
      otelExporterType: exporterType,
      otelCaptureContent: captureContent,
      source: envEnabled ? "environment" : settingEnabled ? "settings" : "none",
    };
  }
}

function isAtLeastVersion(actual: string, minimum: string): boolean {
  const a = parseSemver(actual);
  const b = parseSemver(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

function parseSemver(value: string): [number, number, number] {
  const parts = value.split(/[.-]/).slice(0, 3);
  return [
    Number.parseInt(parts[0] ?? "0", 10) || 0,
    Number.parseInt(parts[1] ?? "0", 10) || 0,
    Number.parseInt(parts[2] ?? "0", 10) || 0,
  ];
}

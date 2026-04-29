import { createWebviewLogger } from "./TSLogger";

type ProviderInfo = {
  id: string;
  label: string;
  installed: boolean;
  active: boolean;
  version?: string;
};

type ActivityKind = "REQUEST" | "APPROVE" | "BLOCK" | "INFO";

type ActivityEntry = {
  id: number;
  tsIso: string;
  kind: ActivityKind;
  message: string;
  data?: unknown;
};

type IncomingMessage =
  | { type: "lakeburner.providers"; providers: ProviderInfo[] }
  | { type: "lakeburner.activity"; entries: ActivityEntry[] }
  | { type: "lakeburner.autoRun"; enabled: boolean }
  | { type: "lakeburner.error"; reason: string };

type OutgoingMessage =
  | { type: "webview.ready" }
  | { type: "autoRun.toggle" }
  | { type: "autoClick.keep" }
  | { type: "autoClick.calibrate" }
  | { type: "activity.clear" }
  | {
      type: "lakeburner.hostlog";
      kind: "TASK" | "USER" | "INFO" | "WARN" | "ERROR";
      file: string;
      fn: string;
      message: string;
      data?: unknown;
    };

declare function acquireVsCodeApi(): {
  postMessage: (msg: OutgoingMessage) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscodeApi = acquireVsCodeApi();

const log = createWebviewLogger({
  fileName: "Webview.ts",
  postMessage: (msg) => vscodeApi.postMessage(msg as OutgoingMessage),
});

function postMessageToHost(message: OutgoingMessage): void {
  try {
    vscodeApi.postMessage(message);
  } catch (err: unknown) {
    log.error("postMessageToHost", "'postMessage' Failed", {
      reason: err instanceof Error ? err.message : String(err),
      type: message.type,
    });
  }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function renderProviders(providers: ProviderInfo[]): void {
  const root = el<HTMLDivElement>("provider-list");
  if (!root) return;

  root.innerHTML = "";

  if (providers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = "No providers configured.";
    root.appendChild(empty);
    return;
  }

  for (const p of providers) {
    const card = document.createElement("div");
    card.className = "provider";
    if (p.installed) card.classList.add("is-installed");
    if (p.active) card.classList.add("is-active");

    const dot = document.createElement("span");
    dot.className = "dot";
    card.appendChild(dot);

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.label;
    meta.appendChild(name);

    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = p.installed
      ? `${p.id}${p.version ? ` · v${p.version}` : ""}`
      : `${p.id} · not installed`;
    meta.appendChild(sub);

    card.appendChild(meta);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = p.active ? "active" : p.installed ? "idle" : "missing";
    card.appendChild(badge);

    root.appendChild(card);
  }
}

function renderActivity(entries: ActivityEntry[]): void {
  const root = el<HTMLDivElement>("activity-log");
  if (!root) return;

  root.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = "No activity yet. Try `@lakeburner advise <plan>` in Copilot Chat.";
    root.appendChild(empty);
    return;
  }

  const sorted = entries.slice().sort((a, b) => b.id - a.id);

  for (const entry of sorted) {
    const item = document.createElement("div");
    item.className = "activity-item";

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = entry.tsIso.slice(11, 19);
    item.appendChild(ts);

    const kind = document.createElement("span");
    kind.className = `kind ${entry.kind}`;
    kind.textContent = entry.kind;
    item.appendChild(kind);

    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = entry.message;
    item.appendChild(msg);

    root.appendChild(item);
  }
}

function renderAutoRun(enabled: boolean): void {
  const btn = el<HTMLButtonElement>("autoRunBtn");
  const state = el<HTMLSpanElement>("autoRunState");
  if (btn) btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  if (state) state.textContent = enabled ? "ON" : "OFF";
}

function bindButtons(): void {
  const autoRunBtn = el<HTMLButtonElement>("autoRunBtn");
  if (autoRunBtn) {
    autoRunBtn.addEventListener("click", () => {
      log.user("ui.autoRun.toggle", "Auto-Run Toggled");
      postMessageToHost({ type: "autoRun.toggle" });
    });
  }

  const pressKeepBtn = el<HTMLButtonElement>("pressKeepBtn");
  if (pressKeepBtn) {
    pressKeepBtn.addEventListener("click", () => {
      log.user("ui.autoClick.keep", "Press Keep Clicked");
      postMessageToHost({ type: "autoClick.keep" });
    });
  }

  const calibrateBtn = el<HTMLButtonElement>("calibrateBtn");
  if (calibrateBtn) {
    calibrateBtn.addEventListener("click", () => {
      log.user("ui.autoClick.calibrate", "Calibrate Clicked");
      postMessageToHost({ type: "autoClick.calibrate" });
    });
  }

  const clearBtn = el<HTMLButtonElement>("clearActivityBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      log.user("ui.activity.clear", "Activity Clear Clicked");
      postMessageToHost({ type: "activity.clear" });
    });
  }
}

function handleIncoming(message: IncomingMessage): void {
  if (!message || typeof (message as { type?: unknown }).type !== "string") return;

  switch (message.type) {
    case "lakeburner.providers":
      renderProviders(message.providers ?? []);
      return;
    case "lakeburner.activity":
      renderActivity(message.entries ?? []);
      return;
    case "lakeburner.autoRun":
      renderAutoRun(!!message.enabled);
      return;
    case "lakeburner.error":
      log.error("host", message.reason);
      return;
  }
}

function main(): void {
  log.setLevel("Basic");
  bindButtons();

  window.addEventListener("message", (event: MessageEvent) => {
    try {
      handleIncoming(event.data as IncomingMessage);
    } catch (err: unknown) {
      log.error("message", "Unhandled Exception in Message Handler", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  postMessageToHost({ type: "webview.ready" });
  log.info("boot", "'webview.ready' Posted");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

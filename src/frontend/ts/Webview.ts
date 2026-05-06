import { createWebviewLogger } from "./Logger";

type ProviderInfo = {
  id: string;
  label: string;
  installed: boolean;
  active: boolean;
  version?: string;
  observability?: ProviderObservability;
};

type ProviderObservability = {
  otelCapable: boolean;
  otelEnabled: boolean;
  otelEndpoint?: string;
  otelExporterType?: string;
  otelCaptureContent: boolean;
  source: "settings" | "environment" | "none";
};

type ActivityKind = "REQUEST" | "APPROVE" | "BLOCK" | "INFO";

type ActivityEntry = {
  id: number;
  tsIso: string;
  kind: ActivityKind;
  message: string;
  data?: unknown;
};

type PromptTarget = { id: string; label: string; command: string; mode: string };

type ChatSessionRecord = {
  id: string;
  label: string;
  firstSeenIso: string;
  lastSeenIso: string;
  turns: number;
};

type IncomingMessage =
  | { type: "lakeburner.providers"; providers: ProviderInfo[] }
  | { type: "lakeburner.activity"; entries: ActivityEntry[] }
  | { type: "lakeburner.autoRun"; enabled: boolean }
  | { type: "lakeburner.prompt"; targets: PromptTarget[]; defaultPrompt: string }
  | { type: "lakeburner.affectedChats"; sessions: ChatSessionRecord[]; allowedIds: string[] }
  | { type: "lakeburner.error"; reason: string };

type OutgoingMessage =
  | { type: "webview.ready" }
  | { type: "autoRun.toggle" }
  | { type: "prompt.send"; targetId: string; prompt: string }
  | { type: "prompt.saveDefault"; prompt: string }
  | { type: "affectedChats.remove"; id: string }
  | { type: "affectedChats.clear" }
  | { type: "activity.clear" }
  | { type: "activity.copy" }
  | { type: "activity.popout" }
  | { type: "provider.switch"; id: string }
  | { type: "provider.login"; id: string }
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

    if (p.observability) {
      const obs = document.createElement("span");
      obs.className = "sub obs";
      const enabled = p.observability.otelEnabled ? "OTel on" : "OTel off";
      const capable = p.observability.otelCapable ? "" : " · needs VS Code 1.119+";
      const capture = p.observability.otelCaptureContent ? " · content capture" : "";
      obs.textContent = `${enabled}${capable}${capture}`;
      obs.title = `${p.observability.otelExporterType ?? "otlp-http"} → ${p.observability.otelEndpoint ?? "(no endpoint)"} (${p.observability.source})`;
      meta.appendChild(obs);
      card.classList.add(p.observability.otelEnabled ? "has-otel" : "no-otel");
    }

    card.appendChild(meta);

    const actionBtn = document.createElement("button");
    actionBtn.className = "provider-action-btn";
    actionBtn.type = "button";
    if (p.installed) {
      actionBtn.textContent = "Switch";
      actionBtn.title = `Switch to ${p.label}`;
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        postMessageToHost({ type: "provider.switch", id: p.id });
      });
    } else {
      actionBtn.textContent = "Login";
      actionBtn.title = `Login / install ${p.label}`;
      actionBtn.classList.add("login");
      actionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        postMessageToHost({ type: "provider.login", id: p.id });
      });
    }
    card.appendChild(actionBtn);

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

    const head = document.createElement("div");
    head.className = "activity-head";

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = entry.tsIso.slice(11, 19);
    head.appendChild(ts);

    const kind = document.createElement("span");
    kind.className = `kind ${entry.kind}`;
    kind.textContent = entry.kind;
    head.appendChild(kind);

    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = entry.message;
    head.appendChild(msg);

    item.appendChild(head);

    if (entry.data !== undefined && entry.data !== null) {
      const details = document.createElement("details");
      details.className = "activity-data";
      const summary = document.createElement("summary");
      summary.textContent = "details";
      details.appendChild(summary);
      const pre = document.createElement("pre");
      try {
        pre.textContent = JSON.stringify(entry.data, null, 2);
      } catch {
        pre.textContent = String(entry.data);
      }
      details.appendChild(pre);
      item.appendChild(details);
    }

    root.appendChild(item);
  }
}

function renderAutoRun(enabled: boolean): void {
  const btn = el<HTMLButtonElement>("autoRunBtn");
  const state = el<HTMLSpanElement>("autoRunState");
  if (btn) btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  if (state) state.textContent = enabled ? "ON" : "OFF";
}

let promptInitialized = false;

// Activity session filtering state
let lastActivityEntries: ActivityEntry[] = [];
let lastKnownSessions: ChatSessionRecord[] = [];

function getSelectedSessionFilter(): string {
  const filter = el<HTMLSelectElement>("activitySessionFilter");
  return filter?.value ?? "all";
}

function updateActivitySessionFilter(sessions: ChatSessionRecord[]): void {
  lastKnownSessions = sessions;
  const filter = el<HTMLSelectElement>("activitySessionFilter");
  if (!filter) return;

  const previous = filter.value;
  filter.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All sessions";
  filter.appendChild(allOpt);

  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    // Show the literal session-id in the dropdown — labels collide too easily
    // (the chat title gets truncated to the same prefix for similar prompts)
    // and the id is what the activity entries are tagged with.
    opt.textContent = s.id;
    opt.title = s.label;
    filter.appendChild(opt);
  }

  if (previous === "all" || (previous && sessions.some((s) => s.id === previous))) {
    filter.value = previous;
  }

  // Re-render activity with current filter
  renderFilteredActivity();
}

function renderFilteredActivity(): void {
  const selectedSession = getSelectedSessionFilter();
  if (!selectedSession) {
    renderActivity([]);
    return;
  }
  // Untagged entries (autorun ticker chatter, system reset messages, etc.)
  // are treated as global and shown for any selected session — they don't
  // belong to one chat but they're still the relevant context for it.
  const filtered = lastActivityEntries.filter((e) => {
    const sid =
      e.data && typeof e.data === "object"
        ? (e.data as { sessionId?: unknown }).sessionId
        : undefined;
    if (selectedSession === "all") return true;
    if (sid === undefined || sid === null || sid === "") return true;
    return sid === selectedSession;
  });
  renderActivity(filtered);
}

function renderPrompt(targets: PromptTarget[], defaultPrompt: string): void {
  const select = el<HTMLSelectElement>("promptTarget");
  const text = el<HTMLTextAreaElement>("promptText");
  if (select) {
    const previous = select.value;
    select.innerHTML = "";
    for (const t of targets) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      opt.title = `${t.command} (${t.mode})`;
      select.appendChild(opt);
    }
    if (previous && targets.some((t) => t.id === previous)) {
      select.value = previous;
    }
  }
  if (text && !promptInitialized) {
    text.value = defaultPrompt ?? "";
    promptInitialized = true;
  }
}

function renderAffectedChats(sessions: ChatSessionRecord[], _allowedIds: string[]): void {
  const root = el<HTMLDivElement>("affected-chats");
  if (!root) return;

  // Auto-expand the Active Fires and Activity sections when there are sessions
  if (sessions.length > 0) {
    const firesSection = document.getElementById("active-fires-section") as HTMLDetailsElement | null;
    if (firesSection && !firesSection.open) firesSection.open = true;
    const activitySection = document.getElementById("activity-section") as HTMLDetailsElement | null;
    if (activitySection && !activitySection.open) activitySection.open = true;
  }

  root.innerHTML = "";

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent =
      "No active fires. Start a Chat or invoke @lakeburner start in any chat to add one.";
    root.appendChild(empty);
    return;
  }

  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "chat-row";
    row.title = `id: ${s.id}\nturns: ${s.turns}\nlast: ${s.lastSeenIso}`;

    const meta = document.createElement("div");
    meta.className = "chat-meta";

    const label = document.createElement("span");
    label.className = "chat-label";
    label.textContent = s.label;
    meta.appendChild(label);

    const sub = document.createElement("span");
    sub.className = "chat-sub";
    const last = s.lastSeenIso ? s.lastSeenIso.replace("T", " ").slice(0, 19) : "";
    sub.textContent = `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${last}`;
    meta.appendChild(sub);

    row.appendChild(meta);

    const removeBtn = document.createElement("button");
    removeBtn.className = "chat-remove-btn";
    removeBtn.type = "button";
    removeBtn.title = "Remove from tracking";
    removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zm-1 0V2H7v1h2zm-4 1v9h6V4H5zm2 2h1v5H7V6zm2 0h1v5H9V6z"/></svg>`;
    removeBtn.addEventListener("click", () => {
      postMessageToHost({ type: "affectedChats.remove", id: s.id });
    });
    row.appendChild(removeBtn);

    root.appendChild(row);
  }
}

function bindButtons(): void {
  const autoRunBtn = el<HTMLButtonElement>("autoRunBtn");
  if (autoRunBtn) {
    autoRunBtn.addEventListener("click", () => {
      log.user("ui.autoRun.toggle", "Auto-Run Toggled");
      postMessageToHost({ type: "autoRun.toggle" });
    });
  }

  const sessionFilter = el<HTMLSelectElement>("activitySessionFilter");
  if (sessionFilter) {
    sessionFilter.addEventListener("change", () => {
      renderFilteredActivity();
    });
  }

  const clearBtn = el<HTMLButtonElement>("clearActivityBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      log.user("ui.activity.clear", "Activity Clear Clicked");
      postMessageToHost({ type: "activity.clear" });
    });
  }

  const copyBtn = el<HTMLButtonElement>("copyActivityBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      log.user("ui.activity.copy", "Activity Copy Clicked");
      postMessageToHost({ type: "activity.copy" });
    });
  }

  const popoutBtn = el<HTMLButtonElement>("popoutActivityBtn");
  if (popoutBtn) {
    popoutBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      log.user("ui.activity.popout", "Activity Popout Clicked");
      postMessageToHost({ type: "activity.popout" });
    });
  }

  const sendPromptBtn = el<HTMLButtonElement>("sendPromptBtn");
  if (sendPromptBtn) {
    sendPromptBtn.addEventListener("click", () => {
      const select = el<HTMLSelectElement>("promptTarget");
      const text = el<HTMLTextAreaElement>("promptText");
      const targetId = select?.value ?? "";
      const prompt = text?.value ?? "";
      if (!targetId || !prompt.trim()) {
        log.warn("ui.prompt.send", "Send Skipped - missing target or prompt");
        return;
      }
      log.user("ui.prompt.send", "Start Chat Clicked", { targetId, length: prompt.length });
      sendPromptBtn.disabled = true;
      sendPromptBtn.classList.add("is-running");
      sendPromptBtn.textContent = "Running...";
      postMessageToHost({ type: "prompt.send", targetId, prompt });
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
      lastActivityEntries = message.entries ?? [];
      renderFilteredActivity();
      return;
    case "lakeburner.autoRun":
      renderAutoRun(!!message.enabled);
      return;
    case "lakeburner.prompt":
      renderPrompt(message.targets ?? [], message.defaultPrompt ?? "");
      return;
    case "lakeburner.affectedChats":
      renderAffectedChats(message.sessions ?? [], message.allowedIds ?? []);
      updateActivitySessionFilter(message.sessions ?? []);
      return;
    case "lakeburner.error":
      log.error("host", message.reason);
      return;
  }
}

function main(): void {
  log.setLevel("Quiet");
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

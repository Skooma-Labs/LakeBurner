import { createWebviewLogger, type DebugLevel } from "./TSLogger";

type AppMode = "Mode_01" | "Mode_02";

type SettingsPayload = {
  url: string;
  name: string;
  folder: string;
  debugLevel: DebugLevel;
};

type IncomingMessage =
  | { type: "vscplate.settings"; settings: SettingsPayload }
  | { type: "pickFolder.result"; path: string }
  | { type: "vscplate.apiToken.status.result"; hasToken: boolean }
  | { type: "vscplate.apiToken.set.result"; ok: boolean; reason?: string }
  | { type: "vscplate.apiToken.clear.result"; ok: boolean; reason?: string }
  | { type: "vscplate.error"; ok: false; reason: string }
  | { type: "changeMode"; mode: AppMode };

type OutgoingMessage =
  | { type: "webview.ready" }
  | { type: "pickFolder" }
  | { type: "saveSettings"; url: string; name: string; folder: string }
  | { type: "vscplate.ui.connectionSettings.toggle"; isOpen: boolean }
  | { type: "changeMode"; mode: AppMode }
  | { type: "function01" | "function02" | "function03" }
  | { type: "vscplate.apiToken.set"; token: string }
  | { type: "vscplate.apiToken.clear" }
  | { type: "vscplate.apiToken.status" }
  | {
      type: "vscplate.hostlog";
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
  postMessage: (msg: OutgoingMessage) => vscodeApi.postMessage(msg),
});

function postMessageToHost(message: OutgoingMessage): void {
  try {
    vscodeApi.postMessage(message);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("postMessageToHost", "'postMessage' Failed", { reason, type: message.type });
  }
}

function elementById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function requireElement<T extends HTMLElement>(id: string, purpose: string): T | null {
  const el = elementById<T>(id);
  if (!el) log.warn("bind", "Missing Element", { id, purpose });
  return el;
}

function setButtonPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.classList.toggle("is-active", pressed);
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
}

function isDebugLevel(v: unknown): v is DebugLevel {
  return v === "Silent" || v === "Basic" || v === "Loud";
}

function getPersistedMode(): AppMode {
  const state = vscodeApi.getState() as { mode?: unknown } | null;
  return state?.mode === "Mode_02" ? "Mode_02" : "Mode_01";
}

function setPersistedMode(mode: AppMode): void {
  const state = (vscodeApi.getState() as Record<string, unknown> | null) ?? {};
  vscodeApi.setState({ ...state, mode });
}

function getPersistedSettings(): SettingsPayload | null {
  try {
    const state = vscodeApi.getState();
    if (!state || typeof state !== "object") return null;

    const settingsAny = (state as any).settings;
    if (!settingsAny || typeof settingsAny !== "object") return null;

    const url = typeof settingsAny.url === "string" ? settingsAny.url : "";
    const name = typeof settingsAny.name === "string" ? settingsAny.name : "";
    const folder = typeof settingsAny.folder === "string" ? settingsAny.folder : "";

    const debugLevel = isDebugLevel(settingsAny.debugLevel) ? settingsAny.debugLevel : "Silent";

    return { url, name, folder, debugLevel };
  } catch (err: unknown) {
    log.warn("state.restore", "Failed to Restore Cached Settings", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function setPersistedSettings(settings: SettingsPayload): void {
  const state = (vscodeApi.getState() as Record<string, unknown> | null) ?? {};
  vscodeApi.setState({ ...state, settings });
}

function applyModeUi(mode: AppMode): void {
  const oneBtn = elementById<HTMLButtonElement>("modeOneBtn");
  const twoBtn = elementById<HTMLButtonElement>("modeTwoBtn");
  if (!oneBtn || !twoBtn) return;

  setButtonPressed(oneBtn, mode === "Mode_01");
  setButtonPressed(twoBtn, mode === "Mode_02");
}

function validateSettingsInputs(): { ok: true } | { ok: false; reason: string } {
  const urlValue = (elementById<HTMLInputElement>("settingUrl")?.value ?? "").trim();
  const nameValue = (elementById<HTMLInputElement>("settingName")?.value ?? "").trim();

  if (!urlValue) return { ok: false, reason: "URL is required." };
  if (!nameValue) return { ok: false, reason: "Name is required." };

  return { ok: true };
}

function applySettings(settings: SettingsPayload): void {
  const urlInput = elementById<HTMLInputElement>("settingUrl");
  const nameInput = elementById<HTMLInputElement>("settingName");
  const folderInput = elementById<HTMLInputElement>("settingFolder");

  if (urlInput) urlInput.value = settings.url ?? "";
  if (nameInput) nameInput.value = settings.name ?? "";
  if (folderInput) folderInput.value = settings.folder ?? "";
}

function readTokenInput(): string {
  return (elementById<HTMLInputElement>("apiToken")?.value ?? "").trim();
}

function clearTokenInput(): void {
  const el = elementById<HTMLInputElement>("apiToken");
  if (el) el.value = "";
}

function bindConnectionSettingsToggle(): void {
  const root = requireElement<HTMLDivElement>("connection-settings", "collapse root");
  const toggle = requireElement<HTMLDivElement>("connection-settings-toggle", "collapse toggle");
  if (!root || !toggle) return;

  const readIsOpen = () => !root.classList.contains("collapsed");

  toggle.addEventListener("click", () => {
    const wasOpen = readIsOpen();

    root.classList.toggle("collapsed");

    const isOpen = readIsOpen();
    const collapsed = !isOpen;

    log.info("ui.connectionSettings.toggle", isOpen ? "Connection-Settings Expanded" : "Connection-Settings Closed", {
      wasOpen,
      isOpen,
      collapsed,
    });

    postMessageToHost({ type: "vscplate.ui.connectionSettings.toggle", isOpen });
  });
}

function bindPickFolderButton(): void {
  const btn = requireElement<HTMLButtonElement>("pickFolder", "Pick Folder Button");
  if (!btn) return;

  btn.addEventListener("click", () => {
    log.info("ui.pickFolder.click", "'Open' Folder Navigator Button Clicked'");
    postMessageToHost({ type: "pickFolder" });
  });
}

function bindSaveSettingsButton(): void {
  const btn = requireElement<HTMLButtonElement>("saveSettings", "Save Settings Button");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const urlValue = (elementById<HTMLInputElement>("settingUrl")?.value ?? "").trim();
    const nameValue = (elementById<HTMLInputElement>("settingName")?.value ?? "").trim();
    const folderValue = (elementById<HTMLInputElement>("settingFolder")?.value ?? "").trim();
    const tokenValue = readTokenInput();

    const validation = validateSettingsInputs();
    if (!validation.ok) {
      log.warn("settings.validate", validation.reason, {
        missingUrl: !urlValue,
        missingName: !nameValue,
      });
      return;
    }

    log.info("ui.settings.save", "Settings Save Clicked", {
      hasToken: tokenValue.length > 0,
      hasFolder: folderValue.length > 0,
    });

    if (tokenValue.length > 0) {
      postMessageToHost({ type: "vscplate.apiToken.set", token: tokenValue });
      clearTokenInput();
    }

    postMessageToHost({
      type: "saveSettings",
      url: urlValue,
      name: nameValue,
      folder: folderValue,
    });

    postMessageToHost({ type: "vscplate.apiToken.status" });
  });
}

function emitChangeMode(mode: AppMode, reason: "click" | "restore" | "host"): void {
  setPersistedMode(mode);
  applyModeUi(mode);

  log.info("ui.mode.change", `Mode toggled to ${mode}`, { mode, reason });
  postMessageToHost({ type: "changeMode", mode });
}

function bindModeToggleButtons(): void {
  const oneBtn = requireElement<HTMLButtonElement>("modeOneBtn", "Mode_01 toggle");
  const twoBtn = requireElement<HTMLButtonElement>("modeTwoBtn", "Mode_02 toggle");
  if (!oneBtn || !twoBtn) return;

  oneBtn.addEventListener("click", () => emitChangeMode("Mode_01", "click"));
  twoBtn.addEventListener("click", () => emitChangeMode("Mode_02", "click"));
}

function bindTaskButtons(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action]"));

  if (buttons.length === 0) {
    log.warn("bind", "No Task Buttons Found");
    return;
  }

  for (const btn of buttons) {
    const actionType = (btn.getAttribute("data-action") ?? "").trim();

    btn.addEventListener("click", () => {
      if (actionType === "function01" || actionType === "function02" || actionType === "function03") {
        log.info("ui.task.click", "Task Clicked", { task: actionType });
        postMessageToHost({ type: actionType });
        return;
      }

      log.warn("ui.task.click", "Unknown Action", { action: actionType });
    });
  }
}

function handleIncomingMessage(message: IncomingMessage): void {
  if (!message || typeof (message as any).type !== "string") return;

  switch (message.type) {
    case "vscplate.settings": {
      const settings = message.settings ?? ({} as SettingsPayload);

      const nextLevel = isDebugLevel(settings.debugLevel) ? settings.debugLevel : "Basic";
      log.setLevel(nextLevel);

      log.installConsoleForwarding();

      applySettings(settings);
      setPersistedSettings(settings);

      const validation = validateSettingsInputs();
      if (!validation.ok) log.warn("settings.validate", validation.reason);

      log.info("settings.sync", "Settings Applied", {
        fields: ["url", "name", "folder", "debugLevel"],
      });

      return;
    }

    case "pickFolder.result": {
      const input = elementById<HTMLInputElement>("settingFolder");
      if (input) input.value = message.path;

      log.info("ui.pickFolder.result", "Folder Selected", { hasPath: !!message.path });
      return;
    }

    case "changeMode": {
      emitChangeMode(message.mode, "host");
      return;
    }

    case "vscplate.apiToken.status.result":
    case "vscplate.apiToken.set.result":
    case "vscplate.apiToken.clear.result":
      return;

    case "vscplate.error":
      log.error("host", message.reason);
      return;

    default:
      return;
  }
}

function main(): void {
  log.info("boot", "Webview boot");

  bindConnectionSettingsToggle();
  bindPickFolderButton();
  bindSaveSettingsButton();
  bindModeToggleButtons();
  bindTaskButtons();

  applyModeUi(getPersistedMode());

  window.addEventListener("message", (event: MessageEvent) => {
    try {
      handleIncomingMessage(event.data as IncomingMessage);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("message", "Unhandled Exception in Message Handler", { reason });
    }
  });

  postMessageToHost({ type: "webview.ready" });
  log.info("boot", "'webview.ready' Posted");

  const cached = getPersistedSettings();
  if (cached) {
    applySettings(cached);

    const nextLevel = isDebugLevel(cached.debugLevel) ? cached.debugLevel : "Basic";
    log.setLevel(nextLevel);

    log.installConsoleForwarding();

    log.info("state.restore", "Cached Settings Restored", {
      fields: ["url", "name", "folder", "debugLevel"],
    });
  }

  applyModeUi(getPersistedMode());
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

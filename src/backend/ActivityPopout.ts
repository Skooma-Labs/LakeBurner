import * as vscode from "vscode";
import type { ActivityLog } from "./ActivityLog";
import type { AffectedChats } from "./AffectedChats";

/**
 * ActivityPopout — opens a wide WebviewPanel that mirrors the sidebar
 * Activity Log in real time. Useful for watching the auto-clicker tick
 * stream while a chat is generating in the main editor area.
 *
 * Single-panel singleton: re-invoking reveals the existing panel rather
 * than spawning duplicates.
 *
 * Filter behaviour matches the sidebar: an entry is shown when it has no
 * `data.sessionId` (system-level — ticker chatter, resets) OR its
 * `data.sessionId` equals the dropdown selection.
 */
export class ActivityPopout implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly activity: ActivityLog,
    private readonly affected: AffectedChats
  ) {}

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "lakeburner.activityPopout",
      "LakeBurner — Activity",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;

    panel.webview.html = this.buildHtml(panel.webview);

    const postEntries = (): void => {
      void panel.webview.postMessage({ type: "entries", entries: this.activity.list() });
    };
    const postSessions = (): void => {
      void panel.webview.postMessage({ type: "sessions", sessions: this.affected.list() });
    };
    const postAll = (): void => {
      postEntries();
      postSessions();
    };
    postAll();
    this.subscriptions.push(this.activity.onChange(postEntries));
    this.subscriptions.push(this.affected.onChange(postSessions));

    panel.webview.onDidReceiveMessage(
      async (msg: { type?: string }) => {
        if (msg?.type === "ready") postAll();
        if (msg?.type === "clear") this.activity.clear();
      },
      undefined,
      this.subscriptions
    );

    panel.onDidDispose(
      () => {
        this.panel = null;
        while (this.subscriptions.length) {
          try { this.subscriptions.pop()?.dispose(); } catch { /* ignore */ }
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    while (this.subscriptions.length) {
      try { this.subscriptions.pop()?.dispose(); } catch { /* ignore */ }
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>LakeBurner — Activity</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 12px 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
      z-index: 1;
      flex-wrap: wrap;
    }
    header h1 { margin: 0; font-size: 1.05em; flex: 1; }
    button {
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      border: 1px solid var(--vscode-contrastBorder, transparent);
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
    select {
      appearance: none;
      -webkit-appearance: none;
      background-color: var(--vscode-dropdown-background);
      background-image:
        linear-gradient(45deg, transparent 50%, var(--vscode-dropdown-foreground) 50%),
        linear-gradient(135deg, var(--vscode-dropdown-foreground) 50%, transparent 50%);
      background-position:
        calc(100% - 15px) 50%,
        calc(100% - 10px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-contrastBorder, transparent));
      border-radius: 4px;
      padding: 5px 30px 5px 10px;
      font: inherit;
      max-width: 280px;
      outline: none;
    }
    select:hover {
      border-color: var(--vscode-focusBorder, #007acc);
      background-color: color-mix(in srgb, var(--vscode-dropdown-background) 88%, var(--vscode-list-hoverBackground, #2a2d2e) 12%);
    }
    select:focus {
      border-color: var(--vscode-focusBorder, #007acc);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc);
    }
    select option {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      padding: 6px 10px;
    }
    select option:checked {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground));
    }
    label { font-size: 0.9em; opacity: 0.8; display: flex; align-items: center; gap: 4px; }
    #count { opacity: 0.7; font-size: 0.9em; }
    .row { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .ts { font-family: var(--vscode-editor-font-family); opacity: 0.65; font-size: 0.9em; }
    .kind { font-weight: 600; font-size: 0.78em; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.04em; }
    .kind.REQUEST { background: rgba(100,150,255,0.18); color: #6db3ff; }
    .kind.APPROVE { background: rgba(80,200,120,0.18); color: #66c984; }
    .kind.BLOCK   { background: rgba(255,90,90,0.18); color: #ff7878; }
    .kind.INFO    { background: rgba(180,180,180,0.18); color: var(--vscode-foreground); }
    .msg { flex: 1; word-break: break-word; }
    pre {
      margin: 0;
      padding: 6px 8px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.88em;
      white-space: pre-wrap;
      word-break: break-word;
    }
    details summary { cursor: pointer; opacity: 0.7; font-size: 0.85em; }
    .empty { padding: 24px; text-align: center; opacity: 0.6; }
  </style>
</head>
<body>
  <header>
    <h1>Activity</h1>
    <span id="count"></span>
    <label>Session
      <select id="sessionFilter" aria-label="Filter by session">
        <option value="__all__">All sessions</option>
      </select>
    </label>
    <label><input type="checkbox" id="autoscroll" checked /> Auto-scroll</label>
    <button id="clear" type="button" title="Clear all activity entries">Clear</button>
  </header>
  <div id="list"></div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const listEl = document.getElementById('list');
      const countEl = document.getElementById('count');
      const autoscrollEl = document.getElementById('autoscroll');
      const sessionFilterEl = document.getElementById('sessionFilter');
      document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

      function escape(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      }

      function getSessionId(entry) {
        if (!entry || typeof entry !== 'object') return undefined;
        const data = entry.data;
        if (!data || typeof data !== 'object') return undefined;
        const sid = data.sessionId;
        if (sid === undefined || sid === null || sid === '') return undefined;
        return sid;
      }

      function applyFilter(entries) {
        const sel = sessionFilterEl.value || '__all__';
        if (sel === '__all__') return entries;
        // Untagged entries (ticker chatter, resets) are global — show them
        // for any selected session, matching the sidebar's behaviour.
        return entries.filter(e => {
          const sid = getSessionId(e);
          if (sid === undefined) return true;
          return sid === sel;
        });
      }

      function render(allEntries) {
        const entries = applyFilter(allEntries);
        countEl.textContent = entries.length + ' entries';
        if (!entries.length) {
          listEl.innerHTML = '<div class="empty">No activity yet.</div>';
          return;
        }
        const sorted = entries.slice().sort((a, b) => b.id - a.id);
        const html = sorted.map(e => {
          const t = (e.tsIso || '').slice(11, 19);
          let dataHtml = '';
          if (e.data !== undefined && e.data !== null) {
            let body;
            try { body = JSON.stringify(e.data, null, 2); } catch { body = String(e.data); }
            dataHtml = '<details><summary>details</summary><pre>' + escape(body) + '</pre></details>';
          }
          return '<div class="row">' +
            '<div class="head">' +
              '<span class="ts">' + escape(t) + '</span>' +
              '<span class="kind ' + escape(e.kind) + '">' + escape(e.kind) + '</span>' +
              '<span class="msg">' + escape(e.message) + '</span>' +
            '</div>' + dataHtml +
            '</div>';
        }).join('');
        listEl.innerHTML = html;
        if (autoscrollEl.checked) {
          window.scrollTo({ top: 0 });
        }
      }

      function renderSessions(sessions) {
        const previous = sessionFilterEl.value || '__all__';
        sessionFilterEl.innerHTML = '';
        const allOpt = document.createElement('option');
        allOpt.value = '__all__';
        allOpt.textContent = 'All sessions';
        sessionFilterEl.appendChild(allOpt);
        for (const s of sessions || []) {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.id;
          opt.title = s.label;
          sessionFilterEl.appendChild(opt);
        }
        if (previous && (previous === '__all__' || (sessions || []).some(s => s.id === previous))) {
          sessionFilterEl.value = previous;
        }
      }

      let lastEntries = [];
      sessionFilterEl.addEventListener('change', () => render(lastEntries));

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'entries') { lastEntries = msg.entries || []; render(lastEntries); }
        if (msg.type === 'sessions') { renderSessions(msg.sessions || []); }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }

}

function makeNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

# LakeBurner

LakeBurner is a VS Code extension for keeping AI coding assistants moving while preserving a visible approval and control layer. It can start or arm chat sessions, silently press visible **Allow** and **Keep** style buttons, and send a configurable nudge prompt when a chat appears idle.

It is designed for GitHub Copilot Chat first, with provider monitoring and dispatch targets for Claude Code and OpenAI Codex style integrations where their VS Code commands are available.

## Requirements

- VS Code `1.119.0` or newer
- Node.js and npm for local development
- Windows for the UI Automation button-press strategy

LakeBurner can still load on non-Windows machines, but the UI Automation strategy that presses visible chat buttons is Windows-only.

## What LakeBurner Does

- **Start a Chat**: dispatches an initial prompt to a configured chat provider and adds that session to Active Fires.
- **Arm an Existing Chat**: `@lakeburner start` promotes the current conversation into Active Fires without requiring a new chat.
- **Stop the Flow**: `@lakeburner stop` turns Auto-Run off and clears all Active Fires.
- **Auto-Press Buttons**: periodically attempts visible **Allow** and **Keep** actions using Windows UI Automation.
- **Nudge Idle Chats**: sends the configured Keep Going prompt after the chat is provably idle.
- **Show Useful Activity**: the in-app Activity view shows `REQUEST`, `APPROVE`, and `BLOCK` events only.
- **Keep Diagnostics in Output**: diagnostic `INFO` traffic goes to the LakeBurner Output channel and obeys `lakeburner.debugLevel`.
- **Show Provider Status**: the Overlords panel tracks configured provider extensions without surfacing internal telemetry plumbing.

## Quick Start

Install dependencies and build:

```bash
npm install
npm run build
```

Run the extension in VS Code:

1. Open this folder in VS Code.
2. Start the **Extension Development Host** from the Run and Debug panel.
3. Open the LakeBurner activity-bar view.
4. Use **Start a Chat**, or type `@lakeburner start` inside an existing chat.

Package a VSIX for testing:

```bash
npm run build
npx @vscode/vsce package
```

The VSIX is written to the repository root by default, for example:

```text
lakeburner-0.8.6.vsix
```

Install it locally:

```bash
code --install-extension ./lakeburner-0.8.6.vsix
```

## Sidebar UI

### Start a Chat

Select a target provider and enter a prompt. LakeBurner registers the prompt as an Active Fire, turns Auto-Run on, and dispatches the prompt through the configured target.

Sample Chat:
"Please create a CSV of various foods and information about them. Set that CSV in `C:\Users\5798017\Downloads` and name it "Cornucopia.csv". If one already exists, scan its contents and improve on it logically, qualitatively, or quantitvely."

Default targets:

- `copilot`: `workbench.action.chat.open`, object argument with `{ mode: "agent" }`
- `claude-code`: `claude-vscode.newConversation`, clipboard handoff
- `codex`: `chatgpt.newChat`, clipboard handoff

Custom dispatch targets are intentionally kept out of the Settings UI; LakeBurner uses the built-in target list unless advanced JSON settings are supplied manually.

### Active Fires

Active Fires are chat sessions LakeBurner is allowed to operate on. The ticker only runs when Auto-Run is on and at least one Active Fire is allow-listed.

Sessions are tracked by a stable hash of the conversation's first prompt because VS Code's stable chat API does not expose a durable session ID.

Ways to add a fire:

- Start a Chat from the LakeBurner sidebar.
- Type `@lakeburner start` in an existing conversation.

Ways to remove fires:

- Use the trash button in the Active Fires list.
- Type `@lakeburner stop` to extinguish all fires and turn Auto-Run off.

The registry is reset on extension activation so a new VS Code session starts cold.

### Activity

The Activity view is intentionally low-noise. It shows:

- `REQUEST`: a prompt, approval request, nudge request, or other user-visible ask
- `APPROVE`: a successful dispatch, press, or approval
- `BLOCK`: a failed dispatch, rejected request, or stop event

`INFO` entries are not shown in the sidebar or Activity popout. They go to the LakeBurner Output channel instead.

### Overlords

The Overlords panel shows provider extension status for:

- GitHub Copilot Chat
- Claude Code
- OpenAI Codex / ChatGPT

OpenTelemetry awareness stays internal. LakeBurner does not enable Copilot telemetry, collect telemetry, send telemetry itself, or display OTel state in the extension UI.

## Chat Participant Commands

LakeBurner contributes the sticky chat participant `@lakeburner`.

### `@lakeburner start`

Registers the current conversation, adds it to Active Fires, turns Auto-Run on, and lets the ticker begin pressing visible Allow/Keep buttons and sending idle nudges.

Use this when you are already in a useful chat and want LakeBurner to take over from there.

### `@lakeburner stop`

Turns Auto-Run off and clears Active Fires. This stops button pressing and Keep Going nudges until you start again.

### `@lakeburner approve <action>`

Requests approval for an action. If Auto-Run is on, LakeBurner returns an automatic approval. If Auto-Run is off, it prompts the user and defaults to blocking on cancel.

### `@lakeburner context <topic>`

Returns basic workspace context such as workspace count, primary folder, active file, language, and debug level.

### `@lakeburner advise <prompt>`

Dispatches a continuation prompt to the configured chat target. With no prompt, LakeBurner asks for one.

## Language Model Tool

LakeBurner also registers `lakeburner_decide`, a VS Code Language Model Tool.

Assistants can invoke it when they need:

- approval for a proposed action
- direction on what to do next

When Auto-Run is on, the tool returns immediate approval or the trust phrase:

```text
Keep going, I trust your intuitions
```

When Auto-Run is off, it uses VS Code confirmation/input UI and defaults toward the safest direction.

## Auto-Run and Nudge Behavior

The ticker is controlled by `lakeburner.autoRun.tickIntervalMs`. It runs only when:

- Auto-Run is on
- `tickIntervalMs` is greater than zero
- at least one Active Fire is allow-listed

Each tick:

1. Optionally checks VS Code window focus.
2. Attempts **Allow** via UI Automation.
3. Attempts **Keep** via UI Automation.
4. If nothing was pressed, probes for chat busy indicators.
5. If the chat has been quiet long enough and passes confirmation checks, dispatches the Keep Going prompt.

The nudge path is deliberately conservative. LakeBurner will not queue a nudge on top of an active generation if it can still see Stop/Cancel or live busy indicators.

## Button Press Strategy

LakeBurner has three button-press strategies:

1. **UI Automation**: preferred, Windows-only, scans VS Code windows for accessible button names and invokes them without moving focus or the mouse.
2. **VS Code commands**: configurable command IDs for Keep/Allow actions.
3. **Coordinate fallback**: optional Windows mouse click at a calibrated position. This is off by default and brittle by design.

The Auto-Run ticker uses UIA-only pressing so it does not steal focus or move the cursor. Manual helper paths can use the command and coordinate fallbacks when configured.

## Logging and Diagnostics

LakeBurner follows the VscPlate debug-level standard through `lakeburner.debugLevel`:

- `Silent`: no Output channel logging
- `Quiet`: step progress only (`TASK`)
- `Loud`: full diagnostic output, including `INFO`

In-app Activity is for operational signal. Output is for diagnostics.

Activity events are mapped into Output logs like this:

- `REQUEST` -> `USER`
- `APPROVE` -> `TASK`
- `BLOCK` -> `WARN`
- `INFO` -> `INFO`, Output-only

Output entries include `lakeburnerActivityId` and `lakeburnerActivityKind` so they can be correlated with Copilot OpenTelemetry spans by timestamp and session metadata.

## OpenTelemetry Awareness

VS Code 1.119 introduced Copilot Chat OpenTelemetry for agent sessions. LakeBurner can read the relevant Copilot settings and environment variables for internal diagnostics and correlation:

- `github.copilot.chat.otel.enabled`
- `github.copilot.chat.otel.exporterType`
- `github.copilot.chat.otel.otlpEndpoint`
- `github.copilot.chat.otel.captureContent`
- `COPILOT_OTEL_ENABLED`
- `COPILOT_OTEL_ENDPOINT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_PROTOCOL`
- `COPILOT_OTEL_CAPTURE_CONTENT`

This is optional under-the-hood observability support. LakeBurner does not depend on OTel for its control loop and does not show OTel status in the extension UI.

## Important Settings

### General

- `lakeburner.debugLevel`: Output verbosity, one of `Silent`, `Quiet`, or `Loud`.

### Auto-Run

- `lakeburner.autoRun.tickIntervalMs`: ticker interval in milliseconds. Default `3000`.
- `lakeburner.autoRun.requireWindowFocus`: only tick while the VS Code window is focused. Default `true`.
- `lakeburner.autoRun.keepGoingEnabled`: enable idle nudge dispatch. Default `true`.
- `lakeburner.autoRun.keepGoingAfterIdleMs`: required quiet time before nudging. Default `15000`.
- `lakeburner.autoRun.keepGoingIdleStreak`: number of consecutive idle confirmations. Default `3`.
- `lakeburner.autoRun.keepGoingPrompt`: text sent when a chat is idle.
- `lakeburner.autoRun.keepGoingTargetId`: prompt target for nudges. Default `copilot`.

### Active Fires

- `lakeburner.affectedChats.windowDays`: how long tracked sessions stay visible. Default `3`.
- `lakeburner.affectedChats.autoAllowNewSessions`: auto-allow new `@lakeburner` sessions. Default `true`.

### UI Automation

- `lakeburner.uia.enabled`: enable Windows UI Automation. Default `true`.

### Command and Coordinate Fallbacks

- `lakeburner.autoClick.preferCommand`: try commands before UIA in non-ticker flows.
- `lakeburner.autoClick.fallbackEnabled`: enable coordinate fallback. Default `false`.
- `lakeburner.autoClick.fallbackPosition`: captured Keep click position.
- `lakeburner.autoApprove.fallbackPosition`: captured Allow click position.

### Prompt Dispatch

- `lakeburner.initialPrompt.default`: default text for Start a Chat.

### Local Command Injection

- `lakeburner.localCommandInjection.enabled`: listen on localhost for trusted local app commands. Default `true`.
- `lakeburner.localCommandInjection.port`: localhost TCP port. Default `19816`.

## Commands

Command palette commands:

- `LakeBurner: Toggle Auto-Run`
- `LakeBurner: Open Activity Popout`
- `LakeBurner: Start a Chat`

Package commands:

```bash
npm run clean
npm run compile
npm run build-webview
npm run copy-static
npm run build
npm run vscode:prepublish
```

## Project Structure

```text
src/main.ts                         extension activation and wiring
src/backend/ActivityLog.ts          in-app activity buffer and Output correlation
src/backend/ActivityPopout.ts       popout Activity webview
src/backend/AffectedChats.ts        Active Fires registry and allowlist
src/backend/AutoClicker.ts          command/UIA/coordinate button press pipeline
src/backend/AutoRunMode.ts          global Auto-Run state
src/backend/AutoRunTicker.ts        Allow/Keep polling and idle nudge dispatch
src/backend/ChatParticipant.ts      @lakeburner chat participant
src/backend/LmTools.ts              lakeburner_decide language model tool
src/backend/PromptDispatcher.ts     prompt target routing
src/backend/ProviderMonitor.ts      provider and Copilot OTel status
src/backend/UIAAutoClicker.ts       Windows UI Automation scanner/invoker
src/frontend/                      sidebar webview HTML/CSS/client code
node_scripts/                      build helpers for webview/static assets
resources/                         extension icons
```

## Security and Privacy

- LakeBurner runs locally inside VS Code.
- LakeBurner does not proxy provider credentials.
- LakeBurner does not enable or export Copilot OpenTelemetry.
- Copilot OTel content capture is only reported when you enable it through Copilot settings or environment variables.
- UIA scans are restricted to configured VS Code process names.
- Coordinate fallback is opt-in and should be used only when UIA/commands are insufficient.
- In-app Activity is in-memory and capped. Session metadata is kept in VS Code extension global state and reset on activation.

## Known Limitations

- UI Automation requires Windows.
- Provider command IDs can change as provider extensions evolve.
- The busy detector is conservative by design; false positives delay nudges, false negatives could queue prompts too early.
- VS Code does not expose a stable chat session ID through the stable API, so LakeBurner fingerprints sessions from prompt text.
- The current VSIX packaging includes source files unless a `.vscodeignore` or package `files` list is added.

## Development Notes

Build:

```bash
npm install
npm run build
```

Package:

```bash
npx @vscode/vsce package
```

Install packaged extension:

```bash
code --install-extension ./lakeburner-0.8.6.vsix
```

Before sharing broadly, add a `LICENSE` file and a `.vscodeignore` to keep the VSIX lean.

## License

AGPL-3.0-only — see [LICENSE](LICENSE) for the full text.

## Links

- Repository: https://github.com/skooma-labs/LakeBurner
- Issues: https://github.com/skooma-labs/LakeBurner/issues

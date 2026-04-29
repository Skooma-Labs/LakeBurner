# VscPlate — VS Code Extension Template

A generic VS Code sidebar extension template with a webview UI and structured logging.

## Features

- **Mode Toggle** — Switch between `Mode_01` and `Mode_02` to control behaviour.
- **Function Buttons** — Three action buttons (`Function_01`, `Function_02`, `Function_03`) that run stub tasks (replace with your logic).
- **Connection Settings** — Collapsible panel to configure API Token, URL, Name, and working Folder.
- **Secret Storage** — API tokens are stored in VS Code's secure secret store.
- **Structured Logging** — Consistent `[timestamp][file][function][kind][data] message` format across TypeScript.

## Quick Start

```bash
npm install
npm run build
```

Press **F5** in VS Code to launch an Extension Development Host.

## Project Structure

```
VscPlate/
├─ resources/            # Icons and images
├─ node_scripts/
│  ├─ build-webview.mjs  # esbuild config for webview bundle
│  └─ dist-copy.js       # Copies static assets to dist/
├─ src/
│  ├─ main.ts            # Extension entry point
│  ├─ frontend/
│  │  ├─ index.html      # Webview HTML shell
│  │  ├─ styles.css      # Webview styling
│  │  └─ ts/
│  │     ├─ Webview.ts          # Browser-side UI logic
│  │     ├─ HostController.ts   # Message router between webview and host
│  │     ├─ HelperFunks.ts      # Shared utilities and types
│  │     └─ TSLogger.ts         # Structured TypeScript logger
│  └─ pslib/                    # (removed — add your own backend scripts here)
├─ package.json
├─ tsconfig.json
└─ README.md
```

## Configuration

Settings are exposed under the `vscplate` section in VS Code Settings:

| Setting              | Description                          |
|----------------------|--------------------------------------|
| `vscplate.url`       | Base URL for your service / API      |
| `vscplate.name`      | Project or resource name             |
| `vscplate.folder`    | Working folder for output files      |
| `vscplate.debugLevel`| Logging verbosity: Silent/Basic/Loud |

## Customisation

1. **Rename modes** — Search for `Mode_01` / `Mode_02` and replace with your mode names.
2. **Rename functions** — Search for `Function_01` / `Function_02` / `Function_03` and replace with your action names.
3. **Add business logic** — Edit the `runTask` method in `HostController.ts` or add your own backend scripts.
4. **Rebrand** — Update `package.json` fields (`name`, `displayName`, `publisher`, `icon`) and resource images.
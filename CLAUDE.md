# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start Electron app with Vite dev server (HMR on renderer only)
npm run build        # TypeScript check → Vite bundle → electron-builder installers
npm run build:ci     # Build without packaging (CI environments)
npm run lint         # ESLint with zero-warnings policy
npm run preview      # Preview production build locally
```

No test suite is currently configured.

## Architecture

This is an **Electron + Vite + React + TypeScript** desktop application with two isolated processes:

### Main Process (`electron/`)
- `main.ts` — Window lifecycle, IPC handler registration, loads renderer URL
- `preload.ts` — Secure context bridge; exposes `window.ipcRenderer` with `on/off/send/invoke`
- `update.ts` — Auto-updater via GitHub releases (electron-updater)

The renderer is **sandboxed** (no `nodeIntegration`). All Node/Electron API access from the renderer must go through the preload bridge.

### Renderer Process (`src/`)
- `main.tsx` → `App.tsx` — React 18 app entry
- Styled with **Tailwind CSS 4 + DaisyUI 5**
- Communicates with main process via `window.ipcRenderer`

### IPC Pattern
```ts
// Renderer → Main (invoke/handle)
const result = await window.ipcRenderer.invoke('channel-name', ...args)

// Main → Renderer (send/on)
win.webContents.send('channel-name', payload)
window.ipcRenderer.on('channel-name', (_, payload) => { ... })
```

### Auto-Updater IPC Channels
| Channel | Direction | Purpose |
|---|---|---|
| `check-update` | invoke | Check for new version |
| `start-download` | invoke | Download update |
| `quit-and-install` | invoke | Install and restart |
| `update-can-available` | main→renderer | Version availability |
| `download-progress` | main→renderer | Download % |
| `update-downloaded` | main→renderer | Ready to install |
| `update-error` | main→renderer | Error notification |

### Build Output
- `dist/` — Bundled renderer (Chromium)
- `dist-electron/` — Bundled main process (`main.js`, `preload.mjs`)
- `release/{version}/` — Packaged installers (gitignored)

### Vite Config
`vite.config.ts` uses `vite-plugin-electron/simple` for dual-target builds. The preload compiles to `.mjs` (required for ES module + Electron compatibility). `VITE_DEV_SERVER_URL` is injected at dev time to distinguish dev vs production loading.

## Key Constraints

- **ES Modules only** — `"type": "module"` in package.json; no CommonJS `require()`
- **Preload must output `.mjs`** — hardcoded in `main.ts` preload path
- **Main process does not hot-reload** — only the renderer benefits from HMR; restart the app after changing `electron/`
- **`electron-builder.json`** contains placeholder `appId`/`productName` — update before shipping

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | Electron 35 |
| Build tool | Vite 7 |
| UI framework | React 18 |
| Language | TypeScript 5 (strict) |
| Styling | Tailwind CSS 4 + DaisyUI 5 |
| Packaging | electron-builder |
| Updates | electron-updater (GitHub releases) |

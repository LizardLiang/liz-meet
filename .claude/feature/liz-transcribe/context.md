# Context — liz-transcribe

**Gathered:** 2026-05-02
**Status:** Ready for planning

<domain>
## Scope Boundary
liz-transcribe delivers WASAPI loopback + mic dual-stream audio capture on Windows, chunked batch transcription via AssemblyAI with speaker diarization, a local searchable session library backed by SQLite FTS5, and a first-run privacy consent + API key setup flow. Transcripts are post-session only (no live captioning). Single-user, single-machine, Windows-only for v1.
</domain>

<decisions>
## Implementation Decisions

### Microphone Capture Architecture
- Mic captured in the main process via naudiodon or WASAPI N-API addon alongside electron-audio-loopback.
- No IPC audio data transfer — all audio stays in the main process.
- Avoids serialization overhead and memory pressure from streaming raw PCM across the context bridge.

### Renderer Routing Architecture
- React Router v6 (react-router-dom) with config-based routing and loader/action pattern for first-run gating.
- Five routes: first-run privacy gate, API key setup, library, transcript detail, settings.
- src/App.tsx must be converted from its current routing-less shell to a React Router v6 shell with the first-run gate as the entry guard.

### Chunk-to-Upload Handoff Mechanism
- DB-First Write: Phase 2 writes the WAV file AND inserts a chunks DB row (status='pending') atomically.
- Phase 3 polls the DB every 2 seconds for pending chunks.
- Fully restart-safe — a crash between phases leaves a pending row that Phase 3 picks up on next launch. No extra queue dependency required.

### Session Status Update Delivery to Renderer
- Main-Process Push: Phase 3 session finalizer emits win.webContents.send('session:status-changed', { sessionId, newStatus }) whenever a DB status changes.
- Renderer listens on one channel and updates matching library cards reactively.
- Zero polling from the renderer. Consistent with the existing auto-updater push pattern in update.ts.

### Themis's Discretion
No gray areas were deferred to Hephaestus. All four architectural decisions were resolved by the user.
</decisions>

<canonical_refs>
## Canonical References
- `electron/main.ts` — Main process entry; window lifecycle and IPC handler registration point; all new IPC channels registered here.
- `electron/preload.ts` — Context bridge; all new IPC channels must be routed through this file via contextBridge extension.
- `src/App.tsx` — Renderer entry; current routing-less shell; must be converted to React Router v6 shell with first-run gate.
- `package.json` — Dependency baseline; no SQLite, no router, no audio library installed yet; all new deps added here.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `window.ipcRenderer` bridge in `electron/preload.ts`: invoke + on/off already wired; extend contextBridge for new channels rather than replacing.
- `app.getPath('userData')`: Established path for user data; liz-transcribe.db and recordings/ directory should live here.

### Established Patterns
- IPC invoke/handle pattern: Established in the auto-updater — all new channels follow this shape (renderer calls invoke, main registers handle).
- Main-to-renderer push: `win.webContents.send` used in `update.ts` — same pattern must be used for `session:status-changed`.
- Tailwind CSS 4 + DaisyUI 5: btn, card, modal, badge component classes — all UI components must follow this styling pattern.

### Integration Points
- `electron/main.ts`: Register IPC handlers for all new channels (capture start/stop, session list, chunk upload, settings read/write).
- `electron/preload.ts`: Extend contextBridge to expose new channels to renderer.
- `src/App.tsx`: Convert to React Router v6 shell; add first-run gate logic using loader pattern.
</code_context>

<specifics>
## Specific Ideas
- naudiodon or WASAPI N-API addon named explicitly as the mic capture library candidate alongside electron-audio-loopback for loopback.
- DB polling interval locked at 2 seconds for the Phase 3 chunk processor.
- Session status IPC channel name locked as `session:status-changed` with payload shape `{ sessionId, newStatus }`.
- SQLite with FTS5 extension for the session library search backend.
- AssemblyAI (not NVIDIA Riva NIM or Deepgram) as the transcription provider with speaker diarization enabled.
</specifics>

<deferred>
## Deferred Ideas
No out-of-scope ideas were raised during the discuss phase.
</deferred>

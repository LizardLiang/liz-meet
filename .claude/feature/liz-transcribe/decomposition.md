# Decomposition: liz-transcribe

**Agent**: Daedalus (Decomposition)
**Feature**: liz-transcribe
**Date**: 2026-05-02
**Input**: prd.md (r2, post-Nemesis — approved)
**Status**: Complete

---

## Overview

liz-transcribe is a speech-to-text desktop feature for the existing `liz-meet` Electron 35 + React 18 + TypeScript 5 shell. It adds system-audio (WASAPI loopback) + microphone dual-stream capture, chunked batch transcription via AssemblyAI (with a mandatory tech-spec exit gate before the architecture is locked), speaker diarization merging, a searchable session library backed by SQLite + FTS5, and a settings + privacy-consent layer.

**Phases**: 5
**Tasks**: 34
**Critical Path**: Phase 1 → Phase 2 → Phase 3 → Phase 4 (Phase 5 can start after Phase 1)
**Parallel Opportunities**: Phase 4 (Library UI) and Phase 5 (Settings + Privacy) can proceed concurrently once Phase 1 (Data Layer) is complete; Phase 3 (ASR pipeline) and Phase 4/5 have no internal dependency on each other.

---

## Dependency Map

```
Phase 1 (Data Layer + IPC Foundation)
    │
    ├──────────────────────────────────────┐
    │                                      │
Phase 2 (Audio Capture)            Phase 5 (Settings + Privacy)
    │
Phase 3 (ASR Pipeline + Diarization Merge)
    │
    ├──────────────────────────────────────┐
    │                                      │
Phase 4 (Transcript UX + Export)   Phase 4 also pulls from Phase 1
```

Detailed dependencies:
- **Phase 2** hard-depends on Phase 1 (IPC channels, session schema, audio-file storage paths).
- **Phase 3** hard-depends on Phase 2 (audio chunks on disk), Phase 1 (DB writes for segments), and the tech-spec exit gate result (determines FR-TR-2 vs FR-TR-2-FALLBACK).
- **Phase 4** hard-depends on Phase 1 (DB reads) and Phase 3 (segment data shape), soft-depends on Phase 2 (status transitions to exercise in UI).
- **Phase 5** hard-depends on Phase 1 (settings store, safeStorage binding), soft-depends on Phase 3 (API key validation flow touches the upload service).

---

## Phase 1 — Data Layer and IPC Foundation

**Purpose**: Establish the local persistence layer, the IPC channel scaffolding, and the TypeScript type contracts that every other phase consumes. Nothing runs before this phase is done.

### Scope (what IS in this phase)

- SQLite database initialization under `app.getPath('userData')` with WAL mode
- Schema creation and migrations for: `sessions`, `segments`, `speaker_label_overrides`, `settings` tables
- SQLite FTS5 virtual table for full-text search on `segments.text`
- TypeScript type definitions for all domain entities (Session, Segment, SpeakerLabelOverride, Settings, SessionStatus enum)
- IPC channel registry — a central manifest of all channel names, request/response types, and direction (renderer→main, main→renderer)
- Boilerplate IPC handler wiring in `electron/main.ts` (empty stubs with correct type signatures)
- Preload bridge extension: expose the new IPC channels through `window.ipcRenderer` (invoke + on/off)
- Database service class with typed CRUD methods for all entities
- Settings service class (non-secret settings only; key storage delegated to Phase 5)

### Boundaries (what is NOT in this phase)

- Audio capture hardware integration — Phase 2
- AssemblyAI HTTP client — Phase 3
- React UI components — Phases 4 and 5
- OS credential store (`safeStorage`) — Phase 5
- Privacy acknowledgement logic — Phase 5

### Tasks

#### Wave 1 — Types and Schema (no intra-phase dependencies)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 1.1 | Define all TypeScript domain types and the `SessionStatus` enum | `src/types/liz-transcribe.ts` | S | `npx tsc --noEmit` passes with no errors in the new file |
| 1.2 | Write SQLite schema SQL (sessions, segments, speaker_label_overrides, settings tables + FTS5 virtual table) | `electron/db/schema.sql` | S | Manual review: all FK constraints present; FTS5 content table references `segments` |
| 1.3 | Write the IPC channel registry (channel name constants + TypeScript request/response types) | `electron/ipc/channels.ts` | S | `npx tsc --noEmit` — no implicit `any` on channel types |

#### Wave 2 — Database Service (depends on 1.1, 1.2)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 1.4 | Install and configure `better-sqlite3` (or equivalent synchronous SQLite driver); wire DB initialization with WAL mode and schema migration runner | `electron/db/database.ts`, `package.json` | M | `npm run build:ci` succeeds; on first launch the DB file appears under `userData` with the correct tables: `SELECT name FROM sqlite_master WHERE type='table'` returns all 5 expected names |
| 1.5 | Implement `SessionRepository` — typed CRUD (create, findById, findAll, update status, delete) and list-with-pagination | `electron/db/session-repository.ts` | M | Unit-level: `SessionRepository.create({...})` returns a session object with a numeric `id`; `findAll()` returns an array ordered by `created_at DESC` |
| 1.6 | Implement `SegmentRepository` — bulk insert, findBySessionId, FTS5 search (query → matching session ids + snippet) | `electron/db/segment-repository.ts` | M | FTS5: inserting a segment with text "action item" then calling `search("action item")` returns that segment's session id |
| 1.7 | Implement `SpeakerLabelRepository` — upsert override, findBySession | `electron/db/speaker-label-repository.ts` | S | Upsert then findBySession returns the custom label |
| 1.8 | Implement `SettingsRepository` — key/value store with typed defaults | `electron/db/settings-repository.ts` | S | `SettingsRepository.get('chunk_seconds')` returns `10` before any user changes |

#### Wave 3 — IPC Wiring (depends on 1.3, 1.4)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 1.9 | Register all IPC handler stubs in main process (correct channel names, typed params, placeholder return values) | `electron/ipc/handlers.ts`, `electron/main.ts` | S | `npm run build:ci` passes; `ipcMain.handle` calls exist for every channel in `channels.ts` |
| 1.10 | Extend preload bridge to expose all new channels via `contextBridge` | `electron/preload.ts` | S | Renderer-side TypeScript: `window.ipcRenderer.invoke('session:create', ...)` resolves without type error |

### Technical Notes

- Use `better-sqlite3` (synchronous API) over `node-sqlite3` (async) — synchronous is fine in the main process and avoids callback/promise complexity in IPC handlers. Confirm Electron 35 compatibility before lock-in.
- FTS5 content table pattern: `CREATE VIRTUAL TABLE segments_fts USING fts5(text, content=segments, content_rowid=id)`. Triggers on segments insert/update/delete must keep FTS5 in sync.
- IPC channel names: use `domain:verb` format (e.g., `session:create`, `session:list`, `segment:search`). All names live in `channels.ts` as constants — never use string literals in handler/invoke call sites.
- DB file path: `path.join(app.getPath('userData'), 'liz-transcribe.db')`.
- Schema migrations: use a simple version table (`schema_version`) and a sequential migration runner. Overkill tools (Knex, Drizzle) are deferred — the schema is small.

### Acceptance Criteria

- [ ] `npm run build:ci` passes with Phase 1 code in place
- [ ] SQLite DB initializes on first launch with all 5 tables present (including FTS5 virtual table)
- [ ] All domain TypeScript types are defined; no implicit `any` in type files
- [ ] FTS5 search returns correct session id when queried with a phrase matching an inserted segment
- [ ] All IPC channel stubs are registered and reachable from the renderer's TypeScript perspective (no missing channel type errors)
- [ ] CRUD operations on all repositories are exercised in isolation (manual or scripted verification)

---

## Phase 2 — Audio Capture

**Purpose**: Implement WASAPI loopback + microphone dual-stream capture, the recording state machine (idle → recording → paused → stopped), VU meters, pre-flight device checks, and all error/edge cases from FR-CAP and §6.4.

**Depends on**: Phase 1 (IPC channels, session schema for `session:create` and status updates, audio-file paths from SettingsRepository)

### Scope (what IS in this phase)

- Main-process audio capture service using `electron-audio-loopback` for loopback stream and the Web Audio / MediaStream API (via renderer) or native IPC path for mic stream
- Chunking logic: slice each stream into configurable 5–15 s WAV chunks; write chunks to `userData/recordings/<session_id>/` with monotonic sequence numbers
- Session state machine: `idle → recording → paused → stopped`; status persisted to DB via Phase 1 repositories
- IPC handlers for: `capture:start`, `capture:pause`, `capture:resume`, `capture:stop`, `capture:status`
- Pre-flight checks: mic detection, system-audio playing check (soft), API-key presence check (redirect to settings), loopback init failure modal (with WASAPI error code)
- Pause/resume semantics per FR-CAP-8: in-flight uploads not cancelled on pause, 4-hour auto-stop timer, device-removed-during-pause modal
- Device hot-swap handling: detect device-removed event ≤ 1 s, emit banner for single-stream loss, auto-pause for dual-stream loss
- Windows Audio service restart recovery: retry device acquisition every 2 s for up to 30 s
- Sleep/Hibernate detection: clock-jump > 30 s triggers auto-stop with toast
- Orphaned-session recovery: on launch, detect sessions with `status = 'recording'` or `status = 'paused'` and offer recovery
- VU meter IPC: main process emits `capture:vu-update` at ≥ 10 Hz with RMS levels for each active stream
- React recording UI components: pre-flight panel (toggles, VU meters), recording indicator (pulsing red), elapsed timer (`HH:MM:SS`), pause/resume/stop controls, paused amber indicator, offline-buffering banner

### Boundaries (what is NOT in this phase)

- Uploading chunks to AssemblyAI — Phase 3
- Transcript display — Phase 4
- API key entry or storage — Phase 5
- Session library card rendering — Phase 4

### Tasks

#### Wave 1 — Capture Core (no intra-phase dependencies)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 2.1 | Install `electron-audio-loopback`; implement `enableLoopbackAudio()` / `disableLoopbackAudio()` calls in main process; expose loopback-ready flag via IPC | `electron/capture/loopback.ts`, `package.json` | M | `npm run dev` — calling `capture:start` with system-audio toggle on does not throw; loopback flag is true |
| 2.2 | Implement mic stream capture (MediaRecorder path in renderer via IPC, or native main-process stream) with configurable chunk duration; write PCM/WAV chunks to `userData/recordings/<session_id>/mic/` | `electron/capture/mic-recorder.ts` | M | After 30 s recording with mic active, directory contains 3 chunk files (at default 10 s); each file is a valid WAV with non-zero size |
| 2.3 | Implement loopback stream capture (parallel to mic); write chunks to `userData/recordings/<session_id>/system/` | `electron/capture/loopback-recorder.ts` | M | After 30 s recording with system audio playing (YouTube), `system/` directory contains 3 non-empty WAV chunks |
| 2.4 | Implement session state machine and `capture:start` / `capture:stop` IPC handlers; create session DB row on start; update status to `processing` on stop | `electron/capture/session-state.ts`, `electron/ipc/handlers.ts` | M | `capture:start` → DB row exists with `status='recording'`; `capture:stop` → status becomes `'processing'` |

#### Wave 2 — Pause, Pre-flight, Error Handling (depends on 2.1–2.4)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 2.5 | Implement `capture:pause` and `capture:resume` IPC handlers including the 4-hour auto-stop timer | `electron/capture/session-state.ts` | M | Pause sets status to `'paused'`, elapsed timer freezes in UI; resume sets status back to `'recording'` |
| 2.6 | Implement pre-flight checks: no API key (redirect), no mic detected (warning dialog), loopback init failure (modal with WASAPI error code), no system audio playing (soft warning) | `electron/capture/preflight.ts` | M | Simulate no API key: pre-flight returns `{ ok: false, reason: 'no_api_key' }`; UI shows redirect instead of starting recording |
| 2.7 | Implement device hot-swap detection: listen for audio device removal events; emit single-stream-lost banner or dual-stream-auto-pause per §6.4 | `electron/capture/device-monitor.ts` | M | Manual test: unplug USB mic while recording → banner appears within 1 s; recording continues on system stream only |
| 2.8 | Implement orphaned-session recovery on app launch (detect `status='recording'/'paused'` rows, prompt user, queue for transcription or discard) | `electron/capture/recovery.ts` | M | Kill the app mid-recording; relaunch → recovery modal appears with session title and date |

#### Wave 3 — VU Meters + React Recording UI (depends on Wave 2 complete)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 2.9 | Implement VU meter emission in main process (RMS level per active stream at ≥ 10 Hz); consume in renderer | `electron/capture/vu-meter.ts`, `src/components/VuMeter.tsx` | S | During recording, the VU bar visibly responds to audio; numeric readout updates (accessibility) |
| 2.10 | Build pre-flight panel UI: mic toggle, system-audio toggle, live VU meters, Start button (disabled if no API key); pre-flight warning dialog | `src/components/PreflightPanel.tsx` | M | All toggles render; Start is disabled without API key; warning dialog appears on simulated device-absent state |
| 2.11 | Build recording UI: pulsing red indicator (→ amber when paused), `HH:MM:SS` elapsed counter, per-stream VU meters, Pause/Resume/Stop buttons, offline-buffering banner, device-lost banner | `src/components/RecordingUI.tsx` | M | Elapsed timer increments; Pause changes indicator to amber; Stop returns to library |

### Technical Notes

- `electron-audio-loopback` is a native Electron addon. Confirm it builds correctly against Electron 35's Node ABI before starting Phase 2. If it does not, Hephaestus must specify an alternative (e.g., a custom native module or WasapiLoopback via C++ N-API addon).
- Chunks must be named `<seq_zero_padded_6>.wav` (e.g., `000001.wav`) so ordering is unambiguous without a DB lookup.
- VU meter: compute RMS from the raw PCM buffer in a 100 ms window; send the value per stream over `capture:vu-update` main→renderer push channel.
- OS sleep detection: record `Date.now()` on each chunk write; if the gap between two consecutive chunk timestamps exceeds 30 s wall-clock, treat as a sleep event.
- Chunk buffering during network outage: Phase 3 owns the upload, but Phase 2 must guarantee chunks are durably written to disk before Phase 3 reads them. The handoff contract is: chunk file on disk = Phase 2's responsibility; upload state = Phase 3's.

### Acceptance Criteria

- [ ] System-audio and mic streams capture independently; two separate `userData/recordings/<id>/mic/` and `system/` directories appear with correct WAV chunks
- [ ] Mic-only or system-only recording works (toggles respected; other stream directory is absent)
- [ ] Pause freezes chunk production and shows amber indicator; Resume continues into same session
- [ ] 4-hour auto-stop fires and toasts the user with captured audio preserved
- [ ] Device hot-swap: single-stream banner appears within 1 s of unplug; dual-stream triggers auto-pause modal
- [ ] App crash recovery: relaunch shows recovery modal for orphaned sessions
- [ ] VU meters update at ≥ 10 Hz with numeric readout present for accessibility (FR-CAP-6, §5.4)
- [ ] Pre-flight blocks recording without API key; warns on no mic; warns on loopback init failure with error code
- [ ] `npm run lint` passes (zero-warnings policy)

---

## Phase 3 — ASR Pipeline and Diarization Merge

**Purpose**: Implement the upload-during-recording chunked pipeline to AssemblyAI (or the full-session-upload fallback, per the §10.3 exit gate), polling, transcript assembly, two-stream diarization merge, retry/backoff logic, and all failure status transitions.

**Depends on**: Phase 1 (DB writes for segments, session status updates), Phase 2 (WAV chunk files on disk), Phase 5 (API key retrieval from safeStorage — soft dependency; can be mocked during development with a hardcoded key env var)

**Exit Gate Note**: Hephaestus must run the §10.3 chunked-vs-full-session DER comparison (5 sessions × 2 configs, Δ_DER ≤ 5pp) in the tech-spec phase. This phase implements whichever path the gate selects. Tasks below cover both paths; the conditional branch is resolved by the tech-spec verdict before implementation begins.

### Scope (what IS in this phase)

- AssemblyAI HTTP client: `POST /upload` (chunk → URL), `POST /transcript` (URL + `speaker_labels:true`), `GET /transcript/:id` (polling)
- Chunk upload queue: consume chunks from disk as they are written (Phase 2); upload with exponential backoff, 5 retries; persist chunk state (`pending`, `uploading`, `transcribed`, `permanently_failed`) to a `chunks` table (added to schema in Phase 1)
- Transcript polling loop: poll until `status === 'completed'` or `error`; back off on transient failures
- Per-session transcript assembly: merge all `completed` chunks in sequence-number order into a single ordered segment list
- Two-stream diarization merge: mic-stream segments are relabeled as `"You"` per FR-TR-7; system-stream segments retain `Speaker N` labels; timelines are interleaved by `start_seconds`; clock-drift correction within ±200 ms over 60 min
- Session final status transitions: `completed`, `completed_with_failures`, `failed` per FR-TR-3
- `[transcription failed for HH:MM:SS – HH:MM:SS]` placeholder insertion for `permanently_failed` chunks
- Retry affordance IPC: `transcript:retry-chunk`, `transcript:retry-all-failed` — re-submit permanently-failed chunk audio if raw audio is retained
- In-app banner: "ASR provider unreachable — uploads paused" when ≥ 3 consecutive chunks fail with 5xx (cleared on next successful upload)
- Full-session-upload fallback path (FR-TR-2-FALLBACK): buffer audio until stop, then upload two files (one per stream); session card shows "Uploading audio" then "Transcribing"
- Deepgram optional provider stub (behind feature flag): same interface, different HTTP calls (§ 8.2)
- Provider abstraction interface so future providers (NVIDIA NIM) can be added without changing callers

### Boundaries (what is NOT in this phase)

- React components for transcript viewing — Phase 4
- Audio capture — Phase 2
- API key entry UI — Phase 5
- Library card status rendering — Phase 4 (Phase 3 writes the status; Phase 4 reads and displays it)

### Tasks

#### Wave 1 — Provider Client and Schema Extension (no intra-phase dependencies)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 3.1 | Add `chunks` table to DB schema (migration); implement `ChunkRepository` — create, update status, findPendingBySession, findFailedBySession | `electron/db/schema.sql` (migration), `electron/db/chunk-repository.ts` | S | Migration runs on DB open; `ChunkRepository.findPendingBySession(id)` returns array of pending chunks |
| 3.2 | Implement `AssemblyAIClient` with typed methods: `uploadChunk(filePath) → url`, `submitTranscript(url, opts) → transcriptId`, `pollTranscript(id) → TranscriptResult` | `electron/asr/assemblyai-client.ts` | M | With a real API key and a short WAV file, `uploadChunk` returns an HTTPS URL; `submitTranscript` returns a non-empty string id |
| 3.3 | Implement provider abstraction interface (`IASRProvider`) so `AssemblyAIClient` and a future `DeepgramClient` are interchangeable | `electron/asr/provider-interface.ts` | S | `AssemblyAIClient implements IASRProvider` compiles without error |

#### Wave 2 — Upload Queue and Retry (depends on 3.1, 3.2)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 3.4 | Implement chunk upload queue: watch for new chunk files written by Phase 2; enqueue immediately; process with concurrency limit (e.g., 3 parallel uploads); persist state to `chunks` table | `electron/asr/upload-queue.ts` | L | Simulate 6 chunks dropped into the recordings folder → all 6 appear in `chunks` table with `status='transcribed'` within 30 s on a good network connection |
| 3.5 | Implement exponential backoff retry logic: 5 attempts, base 2 s, cap 60 s; on permanent failure update chunk to `permanently_failed`; emit `chunk_lost` telemetry event | `electron/asr/retry-policy.ts` | M | With network blocked, a chunk retries 5 times (observable in logs) then enters `permanently_failed` state |
| 3.6 | Implement "provider unreachable" banner trigger: when ≥ 3 consecutive chunks fail with 5xx, emit `asr:provider-unreachable` event; clear on next successful upload | `electron/asr/upload-queue.ts` | S | Simulate 3 consecutive 5xx responses → `asr:provider-unreachable` event is emitted |

#### Wave 3 — Transcript Assembly and Diarization Merge (depends on 3.4)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 3.7 | Implement transcript assembler: when a session stops (or all chunks are transcribed), collect all `transcribed` chunks in sequence order; parse AssemblyAI utterance objects into `Segment` rows; insert into DB via `SegmentRepository` | `electron/asr/transcript-assembler.ts` | M | After uploading a 3-chunk session, `SegmentRepository.findBySessionId(id)` returns segments with monotonically increasing `start_seconds` |
| 3.8 | Implement two-stream diarization merge: interleave mic and system segments by `start_seconds`; relabel all mic-stream segments to `speakerLabel = 'You'`; enforce ±200 ms drift tolerance (log warning if exceeded) | `electron/asr/diarization-merge.ts` | M | Unit test: given mic segments `[{start:0,end:5}]` and system segments `[{start:2,end:7}]`, merged output has 2 entries ordered by start with mic entry labeled "You" |
| 3.9 | Implement failure placeholder insertion: for each `permanently_failed` chunk, insert a `Segment` row with `text = '[transcription failed for HH:MM:SS – HH:MM:SS]'` and `is_failed_placeholder = true` | `electron/asr/transcript-assembler.ts` | S | A permanently-failed chunk produces a segment row containing the bracketed placeholder text |
| 3.10 | Implement session final status resolver: after assembly, count succeeded and failed chunks; set session status to `completed`, `completed_with_failures`, or `failed`; persist to DB | `electron/asr/session-finalizer.ts` | S | Session with 5 succeeded + 1 permanently_failed chunks ends with `status='completed_with_failures'` |

#### Wave 4 — Retry Affordance and Fallback Path (depends on Wave 3)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 3.11 | Implement `transcript:retry-chunk` and `transcript:retry-all-failed` IPC handlers: re-enqueue failed chunks (only if raw audio file exists on disk); update session status back to `processing` | `electron/ipc/handlers.ts`, `electron/asr/upload-queue.ts` | M | Invoke `transcript:retry-chunk` with a permanently-failed chunk id → chunk status resets to `pending` and re-enters the upload queue |
| 3.12 | Implement FR-TR-2-FALLBACK path (conditional on §10.3 gate): skip per-chunk uploads during recording; buffer audio; on `capture:stop`, submit full session files; show "Uploading audio" then "Transcribing" card status | `electron/asr/full-session-uploader.ts` | M | With fallback mode flag enabled, no uploads occur during recording; after Stop, two uploads (mic + system) are submitted |

### Technical Notes

- AssemblyAI async flow: `POST /upload` → returns `upload_url`; `POST /transcript` with `{ audio_url: upload_url, speaker_labels: true }` → returns `{ id }`; then poll `GET /transcript/:id` every 3–5 s until `status === 'completed'`.
- Clock-drift correction: record the wall-clock timestamp at capture start for each stream (mic and system). When merging, use a linear correction: if the streams drifted by `d` ms over `T` seconds, apply `start_corrected = start_raw * (1 - d/T)` to the system stream. Log the drift value per session.
- Chunk sequence numbers must match the Phase 2 naming convention (`000001.wav`, `000002.wav`, ...) so the assembler can order without DB queries.
- The `chunks` table is the source of truth for chunk state, not the file system. The file system is append-only from Phase 2's perspective; Phase 3 reads but does not delete (Phase 1's `FR-CFG-4` audio-retention setting controls deletion, implemented in Phase 5).
- Feature flag for fallback: `LIZMEET_ASR_MODE = 'chunked' | 'full-session'`; set at build time based on §10.3 gate result documented in tech-spec.md.

### Acceptance Criteria

- [ ] A 10-minute 2-stream recording produces a complete merged segment list with monotonically increasing `start_seconds` and correct "You" labels on mic segments
- [ ] Network outage during recording: chunks buffer, then upload on reconnect; final transcript is complete
- [ ] 5xx provider error on ≥ 3 consecutive chunks triggers "ASR provider unreachable" in-app banner; banner clears on next success
- [ ] Chunk permanent failure produces a `[transcription failed for HH:MM:SS – HH:MM:SS]` placeholder segment
- [ ] Session with ≥ 1 failed + ≥ 1 succeeded chunk ends with `status = 'completed_with_failures'`
- [ ] Session with zero succeeded chunks ends with `status = 'failed'`; raw audio is force-retained regardless of FR-CFG-4
- [ ] `transcript:retry-chunk` re-enqueues the chunk when raw audio exists; shows disabled tooltip when audio is deleted
- [ ] FR-TR-2-FALLBACK path (if gate fails): zero uploads during recording; two uploads at stop; M3 renegotiated in tech-spec
- [ ] `npm run lint` passes

---

## Phase 4 — Transcript UX, Session Library, and Export

**Purpose**: Build the complete user-facing experience: session library with search/filter, transcript viewer, speaker label editing, copy/export, and all session card status states.

**Depends on**: Phase 1 (DB read IPC channels), Phase 3 (segment data shape, session status enum values)

### Scope (what IS in this phase)

- Session library page: list of session cards sorted by `created_at DESC`, showing title, date, duration, status badge, speaker count
- Session status badges with correct colors and labels: `recording`, `paused`, `processing`, `completed`, `completed_with_failures` (with gap count), `failed`
- Full-text search bar: query → FTS5 → matching sessions + snippets with highlighted matching text
- Date range picker and status filter (results update live)
- Session delete flow: confirmation dialog; IPC call that removes DB rows and audio files
- Session detail page: transcript view with segments rendered (speaker label, timestamp, text); mic-stream segments show "You" + non-color marker (icon or bold per §5.4)
- Speaker label rename: inline edit per session; persists via `SpeakerLabelRepository`; "You" renameable per FR-UX-3/4
- Session title and notes editing (FR-UX-2)
- Copy full transcript or selected segments to clipboard (plain text with speaker labels)
- Export to `.txt`, `.md`, `.json` via Electron `dialog.showSaveDialog`
- `completed_with_failures` view: `[transcription failed for ...]` placeholders rendered; "Retry" and "Retry all failed segments" buttons wired to Phase 3 IPC; disabled state when raw audio is deleted
- In-app toast notifications: session completes, session fails, session auto-stopped (sleep/4h pause)
- Processing/recording status view: shows spinner and current status instead of transcript while session is not complete
- Search result deep-link: clicking a search result opens the session and scrolls the matching segment into view

### Boundaries (what is NOT in this phase)

- Audio capture controls — Phase 2
- ASR upload logic — Phase 3
- API key entry, privacy notice — Phase 5
- Live captioning during recording — explicitly out of scope (PRD §1.3)
- In-app transcript editing — explicitly out of scope (PRD §1.3)

### Tasks

#### Wave 1 — Library and Session Card (no intra-phase dependencies)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 4.1 | Build `SessionCard` component: renders title, date, duration, status badge, speaker count; status badge colors and labels match FR-TR-3 status table | `src/components/SessionCard.tsx` | M | Storybook / manual: `completed_with_failures` shows warning-color badge with "N gap(s)" subtitle |
| 4.2 | Build session library page with session list, sorted by date, virtualized for 200+ sessions | `src/pages/LibraryPage.tsx` | M | Library renders first 50 sessions within 500 ms (NFR §5.1); session appears after stop without page reload |
| 4.3 | Build search bar: debounced input → `segment:search` IPC → display matched sessions with highlighted snippet | `src/components/SearchBar.tsx`, `src/pages/LibraryPage.tsx` | M | Typing "action item" returns session cards whose transcripts contain that phrase; matching text is highlighted |
| 4.4 | Build date range picker and status filter; wire to `session:list` IPC with filter params | `src/components/LibraryFilters.tsx` | S | Selecting a date range hides sessions outside that range; selecting "failed" filter shows only failed sessions |
| 4.5 | Build session delete flow: confirmation dialog → `session:delete` IPC → card disappears from library | `src/components/DeleteConfirmDialog.tsx` | S | After confirmation, session card is gone; audio files under `userData/recordings/<id>` are removed |

#### Wave 2 — Transcript Viewer (depends on 4.2 for navigation shell)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 4.6 | Build transcript viewer page: fetch segments via `segment:findBySession` IPC; render each segment with speaker label, timestamp, and text | `src/pages/TranscriptPage.tsx` | M | A 2-speaker session renders all segments; each segment has a visible timestamp and speaker label |
| 4.7 | Implement "You" label rendering: mic-stream segments display "You" literal label + non-color marker (person icon or bold) | `src/components/TranscriptSegment.tsx` | S | Every segment with `stream === 'mic'` shows literal text "You" and includes a visible non-color differentiator |
| 4.8 | Implement speaker label rename: inline edit field per speaker; persists via `speakerlabel:upsert` IPC; updates all segments in view | `src/components/SpeakerLabelEditor.tsx` | M | Rename "Speaker 2" → "Alice"; all Speaker 2 segments now show "Alice"; rename persists after app restart |
| 4.9 | Implement session title and notes edit (FR-UX-2): inline edit on library card or detail page header | `src/components/SessionHeader.tsx` | S | Rename session; title persists after app restart |
| 4.10 | Implement failed-chunk placeholder rendering with "Retry" and "Retry all" buttons; disable when raw audio is absent | `src/components/TranscriptSegment.tsx`, `src/components/RetryPanel.tsx` | M | Placeholder segment renders with "Retry" button; button is disabled and shows tooltip when audio is deleted |

#### Wave 3 — Copy, Export, Toasts (depends on Wave 2)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 4.11 | Implement copy-to-clipboard: copy full transcript or selected segments as plain text with speaker labels and timestamps | `src/components/CopyButton.tsx` | S | Paste into Notepad shows "[HH:MM:SS] You: text" format for each segment |
| 4.12 | Implement export: `.txt`, `.md`, `.json` via `dialog.showSaveDialog`; each format includes speaker labels and timestamps | `electron/ipc/handlers.ts`, `src/components/ExportMenu.tsx` | M | Exported `.json` file opens in VS Code and contains `start`, `end`, `speaker`, `text` fields for each segment |
| 4.13 | Implement in-app toast system: surface `session.completed`, `session.failed`, `session.completed_with_failures`, auto-stop events as one-shot toasts (no OS notification in v1) | `src/components/ToastProvider.tsx` | S | Completing a session while library is visible shows toast exactly once |
| 4.14 | Implement search deep-link: clicking a search result opens the session detail page and scrolls the matching segment into the viewport | `src/pages/TranscriptPage.tsx` | S | Click a search result → correct session opens → matching segment is scrolled into view and highlighted |

### Technical Notes

- Use a virtualized list (e.g., `@tanstack/react-virtual`) for the library to hit the 500 ms render target with 200+ sessions.
- FTS5 snippet extraction: use SQLite's `snippet()` function with a context of ±2 words. Highlight the match in the UI with a `<mark>` element or Tailwind highlight class, not with injected HTML from the DB.
- Speaker label rename updates the `speaker_label_overrides` table, not the raw segment rows. The display layer joins on session overrides at render time so a re-transcription would not lose manual renames.
- Status polling: session cards for `processing` sessions should poll `session:status` via IPC every 3 s and update the badge without a full page reload.

### Acceptance Criteria

- [ ] Library shows sessions with correct status badges matching FR-TR-3 status table
- [ ] Search returns matching sessions with highlighted snippets; search latency ≤ 300 ms on a 200-session library (M5)
- [ ] Date range and status filters work independently and in combination
- [ ] Delete removes DB rows and audio files; confirmation dialog prevents accidental deletion
- [ ] Transcript viewer renders all segments with speaker label, timestamp, text
- [ ] Mic-stream segments display literal "You" and a non-color marker (accessibility: §5.4)
- [ ] Speaker label rename persists across restarts and updates all segments in the session
- [ ] Failed-chunk placeholders render with Retry button; disabled when audio is deleted
- [ ] Copy outputs human-readable plain text with labels; export produces valid `.txt`, `.md`, `.json` files
- [ ] In-app toasts fire once per event; no OS-level notifications
- [ ] `npm run lint` passes

---

## Phase 5 — Settings, Privacy Consent, and API Key Management

**Purpose**: Implement the first-run setup flow (privacy notice acknowledgement + API key entry), settings panel, OS credential store integration, and all privacy/security concerns from §5.3 and FR-CFG.

**Depends on**: Phase 1 (SettingsRepository, IPC stubs for `settings:get`/`settings:set`)

### Scope (what IS in this phase)

- First-run detection: check if privacy acknowledgement exists in settings store; if not, block navigation to library or recording
- Privacy notice screen with all 5 required content items (§5.3.1): provider+region, data path, retention promise, third-party disclaimer, off-ramp text
- Acknowledgement checkbox (disabled Continue until checked); persist record with: notice-version hash (SHA-256 of notice content), timestamp, app version
- Notice invalidation: on launch, compare stored notice hash to current notice content; if different, re-prompt
- API key entry field: paste key, "Test connection" button (`assemblyai:test-connection` IPC), success/failure feedback; non-blocking offline acceptance per §6.4
- API key storage via Electron `safeStorage.encryptString` in main process; plaintext never written to `userData`
- Settings panel: chunk duration (5–15 s slider), audio device defaults (read-only display in v1 — single default device), provider selector (AssemblyAI default; Deepgram if feature-flagged), audio retention toggle (FR-CFG-4 default off)
- Settings → Privacy sub-panel: view current notice, revoke acknowledgement (blocks recording until re-acknowledged)
- Telemetry opt-in: minimal opt-in checkbox for M6 install telemetry; no data sent without opt-in (§5.3)
- App routing: enforce first-run gate before any recording or library access; redirect to setup if no acknowledgement or no API key

### Boundaries (what is NOT in this phase)

- Audio capture — Phase 2
- ASR uploads — Phase 3
- Transcript viewer — Phase 4
- At-rest encryption of audio files — explicitly out of scope (PRD §5.3; BitLocker recommended)

### Tasks

#### Wave 1 — Credential Store and Settings Backend (no intra-phase dependencies)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 5.1 | Implement API key service using `safeStorage.encryptString` / `decryptString`; store encrypted key in a dedicated file under `userData` (not in DB); expose via `apikey:set`, `apikey:get`, `apikey:exists` IPC handlers | `electron/services/api-key-service.ts`, `electron/ipc/handlers.ts` | M | `apikey:set('abc123')` → no plaintext file under `userData`; `apikey:get()` returns `'abc123'`; `safeStorage.encryptString` is called (code-review verification) |
| 5.2 | Implement privacy acknowledgement store: persist `{ noticeHash, timestamp, appVersion }` in `SettingsRepository`; implement hash computation and invalidation check on launch | `electron/services/privacy-service.ts` | S | Set acknowledgement → relaunch → `privacyService.isAcknowledged()` returns `true`; change notice content → hash mismatch → returns `false` |
| 5.3 | Implement `assemblyai:test-connection` IPC handler: attempt a minimal API call with the provided key (e.g., list transcripts); return `{ ok, error }` | `electron/ipc/handlers.ts` | S | Valid key → `{ ok: true }`; invalid key → `{ ok: false, error: '401 Unauthorized' }` |

#### Wave 2 — First-Run UI (depends on 5.1, 5.2)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 5.4 | Build privacy notice screen: render all 5 required content items verbatim; acknowledgement checkbox; Continue disabled until checked; hyperlink to provider privacy policy | `src/pages/PrivacyNoticePage.tsx` | M | Notice contains all 5 items per §5.3.1; Continue is disabled until checkbox is ticked; link opens in OS default browser |
| 5.5 | Build API key entry screen: text field, "Test connection" button with loading/success/offline-warning states; Continue enabled after syntactically valid key entered | `src/pages/ApiKeySetupPage.tsx` | M | Test connection with a real key returns green check; network-down scenario shows non-blocking warning; Continue is enabled |
| 5.6 | Wire first-run gate in app router: if `!privacyAcknowledged` → force to privacy notice; if `!apiKeyExists` → force to API key setup; else → library | `src/App.tsx` | S | Fresh install (cleared `userData`): app opens privacy notice; after acknowledgement + key, opens library; revisiting settings works |

#### Wave 3 — Settings Panel (depends on Wave 1)

| # | Task | Target File(s) | Effort | Verify |
|---|------|----------------|--------|--------|
| 5.7 | Build settings panel: chunk duration slider (5–15 s), audio device display, provider selector, audio retention toggle; persist changes via `settings:set` IPC | `src/pages/SettingsPage.tsx` | M | Change chunk duration to 15 s → setting persists after restart → next recording produces 4 chunks per minute instead of 6 |
| 5.8 | Build Settings → Privacy sub-panel: display current notice (read-only), revoke acknowledgement button (requires confirmation, then blocks recording) | `src/pages/SettingsPage.tsx` | S | Revoke acknowledgement → navigate to new recording → redirected to privacy notice page instead |

### Technical Notes

- `safeStorage` is only available in the main process. The API key must never be passed to the renderer in plaintext; the renderer requests "does key exist" and "test connection" via IPC only.
- Notice version hash: SHA-256 of the concatenated notice text (all 5 required items). Any wording change to the notice must update the hash constant so existing acknowledgements are invalidated.
- Provider selector in settings is a UI affordance for future expansion. In v1, AssemblyAI is the only functional option; Deepgram is listed but behind the feature flag from Phase 3.
- The "Test connection" offline-acceptance path (§6.4): if the test call fails due to network error (not 401/403), accept the key with a warning message. On the next recording, if the first upload returns 401/403, redirect to settings.

### Acceptance Criteria

- [ ] Fresh-install flow: privacy notice appears first; acknowledgement is required to proceed
- [ ] Privacy notice contains all 5 required content items (§5.3.1); hyperlink to provider policy is present
- [ ] Acknowledgement record stored with notice hash, timestamp, app version; changing notice content forces re-acknowledgement on next launch
- [ ] API key stored via `safeStorage`; no plaintext key present under `userData` (code review confirmation)
- [ ] "Test connection" works online (green check) and offline (non-blocking warning); Continue enabled for syntactically valid key
- [ ] Settings persist across restarts: chunk duration, audio retention toggle
- [ ] Revoking acknowledgement in Settings → Privacy blocks recording and redirects to privacy notice
- [ ] App routing gate prevents library/recording access without both acknowledgement and API key
- [ ] `npm run lint` passes

---

## Risks and Cross-Cutting Concerns

### Risks

| # | Risk | Affects | Severity | Mitigation |
|---|------|---------|----------|------------|
| R1 | `electron-audio-loopback` native addon does not build against Electron 35 Node ABI | Phase 2 | High | Hephaestus must verify ABI compatibility in the tech spec before committing to this library. If it fails, a custom WASAPI N-API addon or an alternative loopback approach must be specified before Phase 2 begins. |
| R2 | §10.3 gate fails (Δ_DER > 5pp for chunked vs. full-session) | Phase 3, M3 | High | Phase 3 includes the FR-TR-2-FALLBACK path. If the gate fails, Hephaestus switches the build flag and renegotiates M3 before implementation. |
| R3 | AssemblyAI async poll latency makes M3 (≤ 5 min for 60-min session) miss | Phase 3, M3 | Medium | Chunked upload during recording (not at session end) is the primary mitigation (FR-TR-2). If M3 still misses in testing, batching strategies and parallel polling can be tuned without architecture change. |
| R4 | SQLite FTS5 search latency exceeds 300 ms (M5) on a 200-session library | Phase 1, Phase 4 | Low | FTS5 with proper index should be well under 300 ms at this scale. If not, add a secondary column index on `session_id` in the FTS5 content table. |
| R5 | Clock drift between mic and system-audio streams exceeds ±200 ms over 60 min | Phase 3 | Medium | Addressed in Phase 3 (diarization merge clock-drift correction). Log drift per session; if systematic drift is observed, report to Hephaestus for a correction algorithm review. |
| R6 | Windows audio service restart or sleep/hibernate disrupts capture mid-session in a way the recovery logic does not catch | Phase 2 | Medium | Phase 2 includes sleep detection (clock-jump >30 s) and service-restart retry loop (2 s intervals, 30 s timeout). Edge cases beyond these are logged and surfaced to the user via existing orphaned-session recovery. |

### Cross-Cutting Concerns

| Concern | Phases Affected | Note |
|---------|----------------|------|
| Error handling and user-actionable copy | All | Every error modal and toast must include actionable text (what the user can do). Error copy is part of each phase's implementation — not deferred. |
| Logging | Phase 2, 3 | Structured log entries for: chunk written, chunk uploaded, upload failed (with attempt count), transcript polled, session finalized. Log to a rotating file in `userData/logs/`. Sensitive data (API key, audio content) must never appear in logs. |
| Audio file cleanup (FR-CFG-4) | Phase 1, 3, 5 | Phase 1 defines the setting; Phase 3 enforces force-retain on total-failure sessions; Phase 5 surfaces the toggle. The actual file deletion on successful transcription is triggered from Phase 3's session finalizer, reading the setting from Phase 1's `SettingsRepository`. |
| Accessibility | Phase 2, 4 | VU meters must include numeric readouts (Phase 2, §5.4); all controls must be keyboard-reachable; transcript speaker labels must use non-color markers (Phase 4, FR-UX-3). |
| TypeScript strict mode | All | The repo already has `"strict": true` in `tsconfig.json`. All new files must comply. `npm run build:ci` (which includes `tsc`) must pass at every phase boundary. |
| IPC type safety | Phase 1, all consumers | All IPC call sites must use the channel name constants from `electron/ipc/channels.ts` — never bare string literals. The type definitions in `channels.ts` are the contract; any change requires updating all callsites. |

---

## Implementation Order Recommendation

The recommended execution sequence, accounting for hard dependencies and parallelism opportunities:

1. **Phase 1** — complete first; unblocks everything else.
2. **Phase 2 + Phase 5** — can start in parallel once Phase 1 is complete. Phase 5 (settings backend and first-run UI) has no dependency on audio capture.
3. **Phase 3** — start after Phase 2 has a working chunk-file output; the tech-spec exit gate result must be confirmed before implementing the upload path.
4. **Phase 4** — can be scaffolded (library UI with mock data) in parallel with Phase 3; final wiring requires Phase 3's segment data shape.

Total estimated effort: ~34 tasks across 5 phases. Rough breakdown:
- Phase 1: 10 tasks (4S, 4M, 2 implied by schema)
- Phase 2: 11 tasks (4S, 6M, 1L)
- Phase 3: 12 tasks (3S, 7M, 1L, 1 conditional)
- Phase 4: 14 tasks (4S, 8M, 2 implied)
- Phase 5: 8 tasks (2S, 5M, 1 implied)

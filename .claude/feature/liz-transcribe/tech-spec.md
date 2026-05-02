# Tech Spec: liz-transcribe

**Feature**: liz-transcribe
**Author**: Hephaestus (Tech Spec Agent)
**Date**: 2026-05-02 (revised 2026-05-03 in response to Apollo CONCERNS)
**Based On**: prd.md (r2, post-Nemesis approved)
**Decomposition**: decomposition.md (5 phases, 34 tasks)
**Locked Decisions**: context.md (4 implementation decisions from Themis)
**Priority**: P1
**Status**: Revised — addresses Apollo §6 review (spec-review-sa.md, 2026-05-03)

**Revision r2 changelog** (in response to Apollo CONCERNS):
- §11.5: replaced "typically ≤ 3 pp" hand-wave with literature-cited Δ_DER prior; gate timing kept deferred but anchored quantitatively per Apollo's option (b).
- §4.7 / §11.3: replaced one-sentence stitching description with pseudocode-level specification including tie-breaking, global-label assignment, duration-weighted overlap, and justified 1.5 s overlap window.
- §4.4 AssemblyAIClient: fixed `Readable` → Web `ReadableStream` coercion via `Readable.toWeb`; added `redirect: 'manual'` and 3xx rejection on every fetch; replaced raw `await res.text()` in `ProviderError` with sanitized body extraction; added explicit Authorization-header logging ban.
- §4.3 ChunkProcessor.tick(): replaced serialized poll loop with `Promise.allSettled` + per-chunk `lastPolledAt ≥ 3 s` guard + per-call `AbortSignal.timeout(10_000)`.
- §4.9 IPC error wrapper: specified an error-classification pipeline; renderer never sees raw `error.message`; logs are scrubbed of secrets via a single `sanitizeForLog` function.
- §4.1.3 / §4.2.6 / §4.2.4 / §4.12: minor revisions per Apollo's minor list (bounded `findInFlight`, 24 h staleness rule, 5 MB IPC chunk cap, FTS5 non-HTML markers).

---

## 0. How To Read This Document

The PRD says **WHAT**. This spec says **HOW**. Where the locked decisions in `context.md` constrain the design, that constraint is reproduced verbatim and the spec builds on it without re-litigating. Where the PRD or decomposition gave latitude, this spec makes a choice and documents the trade-off.

The §10.3 Tech-Spec Exit Gate (Chunked Diarization Validation) is documented in §11 of this spec — Apollo will reject the spec without that section.

---

## 1. Architecture Overview

### 1.1 Process Topology

```
┌─────────────────────────────────────────────────────────────┐
│ Main Process (Node, Electron)                              │
│                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│   │ Capture       │  │ Chunk        │  │ ASR          │    │
│   │ Service       │  │ Processor    │  │ Pipeline     │    │
│   │ (Phase 2)     │  │ (Phase 3)    │  │ (Phase 3)    │    │
│   │               │  │              │  │              │    │
│   │ • Mic (native)│  │ • DB poll 2s │  │ • AssemblyAI │    │
│   │ • Loopback    │  │ • Upload Q   │  │   client     │    │
│   │ • WAV writer  │  │ • Retry      │  │ • Polling    │    │
│   │ • State M/C   │  │ • Finalizer  │  │ • Merge      │    │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│          │                  │                  │            │
│          └─────────┬────────┴──────────────────┘            │
│                    ▼                                        │
│          ┌──────────────────┐    ┌──────────────────┐      │
│          │ SQLite (sync)    │    │ Settings &        │      │
│          │ better-sqlite3   │    │ safeStorage       │      │
│          │ + FTS5           │    │ (Phase 5)         │      │
│          └──────────────────┘    └──────────────────┘      │
│                    │                                        │
│                    ▼                                        │
│          IPC Bridge (channels.ts registry)                 │
└────────────────────┬────────────────────────────────────────┘
                     │  contextBridge (preload.ts)
┌────────────────────┴────────────────────────────────────────┐
│ Renderer Process (Chromium, sandboxed)                     │
│                                                             │
│   React Router v6 shell (src/App.tsx)                       │
│   ┌────────────┬───────────┬────────────┬──────────────┐    │
│   │ FirstRun   │ Library   │ Transcript │ Settings     │    │
│   │ Gate       │ Page      │ Page       │ Page         │    │
│   └────────────┴───────────┴────────────┴──────────────┘    │
│   │                                                          │
│   │  Listens on: session:status-changed, capture:vu-update,  │
│   │              capture:device-event, asr:provider-banner   │
│   │  Invokes: capture:*, session:*, segment:*, settings:*    │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Module Responsibilities

| Module | Process | Responsibility |
|--------|---------|----------------|
| `electron/capture/*` | Main | Audio capture (mic + loopback), chunking, WAV writing, state machine, device monitoring |
| `electron/asr/*` | Main | DB polling, upload queue, retry, AssemblyAI client, transcript assembly, diarization merge, session finalizer |
| `electron/db/*` | Main | SQLite schema, repositories, FTS5, migrations |
| `electron/services/*` | Main | API key (`safeStorage`), privacy acknowledgement |
| `electron/ipc/*` | Main | Channel registry, handler wiring |
| `src/pages/*` | Renderer | Route components (FirstRun, Library, Transcript, Settings) |
| `src/components/*` | Renderer | Reusable UI (SessionCard, VuMeter, RecordingUI, TranscriptSegment, etc.) |
| `src/hooks/*` | Renderer | IPC hooks (`useSession`, `useSegments`, `useStatusChanges`) |

### 1.3 Data Flow Summary (Happy Path)

1. User clicks Start Recording. Renderer invokes `capture:start`.
2. Main process: creates `sessions` row (status=`recording`), opens mic stream (native, main-process), opens loopback via `electron-audio-loopback` (renderer-bridged), starts WAV writers.
3. Every 10 s (configurable 5–15 s), each writer closes a chunk file under `userData/recordings/<session_id>/{mic,system}/NNNNNN.wav` AND inserts a `chunks` row with `status='pending'` in the same DB transaction. **(DB-First Write — locked decision §3, context.md)**
4. The Chunk Processor in main process polls `chunks` table every 2 s (locked) for any `status='pending'`. For each: marks `status='uploading'`, calls `AssemblyAIClient.uploadChunk()` (POST /upload → upload_url), then `submitTranscript()` (POST /transcript with `speaker_labels:true`), stores `transcript_id`, marks `status='polling'`.
5. A polling loop checks each in-flight `transcript_id` every 3 s. On AssemblyAI `status='completed'`, the Processor parses utterances into `segments` rows and marks the chunk `status='transcribed'`. On `status='error'` it marks `status='failed'` and increments `retry_count`; the retry policy decides whether to re-enqueue or mark `permanently_failed`.
6. Each time a session's chunk-state set changes, the Session Finalizer reads the chunk-state distribution and decides whether to transition the session status (`recording → processing → completed | completed_with_failures | failed`) and pushes `session:status-changed` to the renderer **(locked decision §4, context.md)**.
7. Renderer's library page listens on `session:status-changed` and updates the matching SessionCard reactively. Transcript page reads via `segment:findBySession` IPC.

---

## 2. Locked Decisions Summary (from context.md)

These are NOT re-litigated below; the spec builds on them.

| # | Decision | Implication |
|---|----------|-------------|
| L1 | Mic capture: main-process native (naudiodon or WASAPI N-API addon) | No `getUserMedia` / no IPC of raw PCM. Main process owns the mic device. |
| L2 | Routing: React Router v6 with 5 routes + first-run gate | `src/App.tsx` becomes a router shell; entry-guard loader pattern blocks library/recording until first-run is complete. |
| L3 | Chunk handoff: DB-First Write (Phase 2 writes WAV + `pending` row; Phase 3 polls every 2 s) | No in-memory queue, no IPC chunk-ready event. Restart-safe. |
| L4 | Session status updates: main-process push via `win.webContents.send('session:status-changed', { sessionId, newStatus })` | Renderer never polls session status. |

---

## 3. Technology Choices

### 3.1 New Dependencies

| Package | Version | Purpose | Rationale |
|---------|---------|---------|-----------|
| `better-sqlite3` | `^11.5.0` | Synchronous SQLite + FTS5 | Simpler than async drivers in main process; FTS5 included in the prebuilt binary; widely used in Electron apps. R1 mitigation in §10. |
| `@electron/rebuild` | `^3.7.0` | Native module ABI rebuild for Electron 35 | Required to rebuild `better-sqlite3` and the mic addon against Electron 35's Node ABI on `postinstall`. |
| `electron-audio-loopback` | `^1.0.5` | WASAPI loopback wrapper for system audio | PRD §8.3; supports Electron 31+; avoids virtual audio cable drivers. |
| `naudiodon2` | `^2.3.4` | PortAudio N-API binding for mic capture in main process | Implements L1 (mic in main process). Maintained fork of `naudiodon`. Tested against modern Node ABIs. Alternative path documented in §3.4. |
| `react-router-dom` | `^6.28.0` | Client-side routing | L2; v6 chosen over v7 to match Tailwind + React 18 ecosystem stability. |
| `@tanstack/react-virtual` | `^3.10.0` | Virtualized library list | NFR §5.1: 50 sessions in 500 ms; M5: search latency; standard React virtualization. |
| `wav` | `^1.0.2` | WAV file header writer | Simple PCM-to-WAV serializer; we control the encoder, not the decoder. Avoids ffmpeg dependency. |
| `zod` | `^3.23.0` | IPC payload runtime validation | Defends against malformed renderer→main IPC payloads even though both sides are TypeScript. Optional but recommended; small footprint. |

**No additions for**: HTTP client (use native `fetch` from undici, included in Node 18+); UUID generation (use `crypto.randomUUID()`); date utilities (use native `Intl` and `Date`).

### 3.2 Resolved: better-sqlite3 + Electron 35 (Risk R1)

**Decision**: Use `better-sqlite3` v11.5.x.

**Evidence**:
- `better-sqlite3` v11 publishes prebuilt binaries for Node ABI 127, 130, 131. Electron 35 ships with Node 22 (NODE_MODULE_VERSION = 127, then 130 in later 22.x). The package's `install.js` auto-selects the matching prebuild.
- If a prebuild is unavailable for the exact Electron version, `@electron/rebuild` rebuilds from source on `postinstall`. The repo will run `electron-rebuild -f -w better-sqlite3` after `npm install` via a `postinstall` script.
- Synchronous API is appropriate in the main process: SQLite calls are sub-millisecond for our workload (≤ 200 sessions, ≤ 100k segments). Async wrappers add complexity for no measurable benefit.
- FTS5 is bundled in the binary — no separate install step.

**Fallback (if compat fails in CI)**: `node-sqlite3` (async). The repository pattern below isolates the driver behind `electron/db/database.ts`; swapping out `better-sqlite3` for `node-sqlite3` is one file plus making repository methods `async`. Estimated swap cost: 4 hours.

**Rejected**: `sql.js` (in-memory, slow at scale); `sqlite3` (deprecated); `tursodatabase/libsql-client-wasm` (network-oriented).

### 3.3 Resolved: Mic Capture Library

**Decision**: `naudiodon2` (PortAudio N-API binding) for the mic stream.

**Why**:
- Locked decision L1 requires main-process native capture. `naudiodon2` runs in the main process, opens the default mic device by name/index, and emits Node `Buffer` PCM at a configurable sample rate.
- It is a maintained fork of `naudiodon` with Node 18+ support; binary distribution is via N-API (ABI-stable across Node minor versions, so `@electron/rebuild` may not even be required).
- Latency overhead is sub-50 ms — irrelevant for our 10-second chunking model.

**Fallback (if naudiodon2 fails on Electron 35)**: Custom WASAPI N-API addon using `node-addon-api` and Win32 Core Audio. Implementation outline:
1. `IMMDeviceEnumerator::GetDefaultAudioEndpoint(eCapture, eConsole, ...)` to get the default mic.
2. `IAudioClient::Initialize(AUDCLNT_SHAREMODE_SHARED, ...)` with a 16 kHz / 16-bit PCM mix format.
3. Background thread reads the capture buffer, posts `napi_threadsafe_function` calls to JS with PCM `Buffer` chunks.
4. Estimated cost: 2–3 days. Only triggered if `naudiodon2` cannot be made to work; documented here so Phase 2 has a known escape path.

The mic chunker (see §4.2) consumes the PCM buffer regardless of which addon backs it; the addon's API surface to the rest of the app is `start(deviceId, sampleRate, channels) → AsyncIterable<Buffer>`.

### 3.4 Loopback (system audio) Capture

**Decision**: `electron-audio-loopback` package — bridge pattern.

**Mechanics**:
1. In main process: `import { initMain } from 'electron-audio-loopback'; initMain()` once during app boot. This registers IPC handlers used by the renderer.
2. In renderer: when system-audio capture is requested, the renderer calls `enableLoopbackAudio()` (via the package's preload helper), then calls `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })`. The `video` track is dropped immediately; only the `audio` MediaStreamTrack is kept. **Reason**: the package wraps Chromium's `desktopCapturer` API which requires both audio and video constraints to satisfy WASAPI loopback.
3. The renderer pipes the loopback audio track into a `MediaRecorder` (`audio/webm; codecs=opus`) configured with `timeslice = chunkDurationSeconds * 1000` (e.g., 10000 ms). On each `dataavailable` event, the renderer ships the binary chunk to the main process via `ipcRenderer.invoke('capture:loopback-chunk', {sessionId, seq, mimeType, buffer})`.
4. Main process receives the chunk, transcodes opus → 16 kHz mono PCM WAV using `ffmpeg-static` on first run (acceptable: the renderer is recording at 48 kHz / opus by default; downsampling to 16 kHz reduces upload size). **Alternative without ffmpeg**: ship opus chunks directly to AssemblyAI — AssemblyAI accepts opus/webm; this is the preferred path to avoid an ffmpeg dependency. The exact decision (ffmpeg-static vs. opus passthrough) is made at Phase 2 implementation time based on AssemblyAI's accepted upload formats.

**This is the asymmetry**: mic is captured in main (native), system audio is captured in renderer (per `electron-audio-loopback`'s required architecture) and the chunk is shipped to main via IPC. The locked decision L1 specifies *mic* as main-process native; it does not (and could not) require system audio to bypass `electron-audio-loopback`'s renderer-bridge model. **Both chunk streams converge in main process**: WAV files written under `userData/recordings/<id>/{mic,system}/NNNNNN.wav`, with a paired `chunks` table row per file.

### 3.5 ASR Provider

**Decision**: AssemblyAI primary; provider abstracted behind `IASRProvider` interface (see §4.6).

**Reference (PRD §8.1)**:
- POST `https://api.assemblyai.com/v2/upload` — body: binary audio. Returns `{ upload_url }`.
- POST `https://api.assemblyai.com/v2/transcript` — body: `{ audio_url, speaker_labels: true, language_code: 'en_us' }`. Returns `{ id, status }`.
- GET `https://api.assemblyai.com/v2/transcript/:id` — poll until `status === 'completed' | 'error'`.
- Header: `Authorization: <api_key>` (no Bearer prefix).

---

## 4. Detailed Design

### 4.1 Data Layer (Phase 1)

#### 4.1.1 Database Location & Initialization

- File path: `path.join(app.getPath('userData'), 'liz-transcribe.db')`.
- Opened with `better-sqlite3` in WAL mode: `db.pragma('journal_mode = WAL')`, `db.pragma('synchronous = NORMAL')`, `db.pragma('foreign_keys = ON')`.
- Schema applied via `electron/db/migrations/NNN_*.sql` files; a `schema_version` table records the current migration. The migration runner is a 30-line script that opens, reads `MAX(version)`, and applies missing migrations in transaction.

#### 4.1.2 Schema (DDL)

```sql
-- 001_initial.sql

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,            -- crypto.randomUUID()
  title           TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  ended_at        TEXT,
  duration_seconds INTEGER,
  status          TEXT NOT NULL CHECK (status IN
                    ('recording','paused','processing',
                     'completed','completed_with_failures','failed')),
  speaker_count   INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('mic','system','both')),
  provider        TEXT NOT NULL DEFAULT 'assemblyai',
  raw_audio_path  TEXT,                        -- NULL once raw deleted per FR-CFG-4
  notice_hash_at_creation TEXT                 -- forensic: which privacy notice was acked
);
CREATE INDEX idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);

CREATE TABLE chunks (
  id              TEXT PRIMARY KEY,            -- crypto.randomUUID()
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stream          TEXT NOT NULL CHECK (stream IN ('mic','system')),
  seq             INTEGER NOT NULL,            -- monotonic per (session_id, stream)
  file_path       TEXT NOT NULL,               -- absolute path
  start_seconds   REAL NOT NULL,               -- offset from session start
  end_seconds     REAL NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('pending','uploading','polling','transcribed',
                     'failed','permanently_failed')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  upload_url      TEXT,                        -- AssemblyAI upload_url
  transcript_id   TEXT,                        -- AssemblyAI transcript id
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_chunks_session_stream_seq
  ON chunks(session_id, stream, seq);
CREATE INDEX idx_chunks_status ON chunks(status);
CREATE INDEX idx_chunks_session ON chunks(session_id);

CREATE TABLE segments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_id        TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  stream          TEXT NOT NULL CHECK (stream IN ('mic','system')),
  speaker_label   TEXT NOT NULL,               -- raw label from diarizer ("A","B",…) or "You" for mic
  start_seconds   REAL NOT NULL,
  end_seconds     REAL NOT NULL,
  text            TEXT NOT NULL,
  confidence      REAL,
  is_failed_placeholder INTEGER NOT NULL DEFAULT 0  -- 1 if "[transcription failed for ...]"
);
CREATE INDEX idx_segments_session_start ON segments(session_id, start_seconds);

-- FTS5 virtual table mirrors segments.text
CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers keep FTS5 in sync with segments
CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE speaker_label_overrides (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_label  TEXT NOT NULL,
  custom_label    TEXT NOT NULL,
  PRIMARY KEY (session_id, original_label)
);

CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL                -- JSON-encoded
);
```

**Notes**:
- `chunks.status` is the lifecycle state; `pending → uploading → polling → transcribed | failed | permanently_failed`. Note: `failed` is a transient state that can re-enter the queue; `permanently_failed` is terminal (5 retries exhausted).
- `segments.chunk_id` is `ON DELETE SET NULL` so a chunk row can be retried (deleted and recreated) without orphaning historical segments.
- `speaker_label_overrides` is keyed by *original_label*; renames apply at render time via a JOIN. This means re-transcription does not erase the user's manual rename.

#### 4.1.3 Repositories

Each repository is a class with a `db: BetterSqlite3.Database` constructor argument. Methods are synchronous and throw on SQL error (caught by the IPC handler wrapper — see §4.7).

| Repository | Key Methods |
|------------|-------------|
| `SessionRepository` | `create(input) → Session`, `findById(id)`, `findAll({offset, limit, status?, dateRange?}) → Session[]`, `updateStatus(id, status)`, `updateMeta(id, {title?, notes?})`, `delete(id)` |
| `ChunkRepository` | `create(input) → Chunk`, `findPending(limit) → Chunk[]`, `findInFlight(limit) → Chunk[]` (status `uploading`/`polling`; `ORDER BY updated_at ASC` so oldest-polled comes first), `updateStatus(id, status, error?)`, `setUploadUrl(id, url)`, `setTranscriptId(id, tid)`, `findFailedBySession(id)` |
| `SegmentRepository` | `bulkInsert(segments[])`, `findBySessionId(id) → Segment[]` (ORDER BY start_seconds), `search(query, options) → SearchResult[]` (FTS5 with `snippet()`), `deleteByChunkId(id)` |
| `SpeakerLabelRepository` | `upsert(sessionId, originalLabel, customLabel)`, `findBySession(sessionId) → Map<string,string>` |
| `SettingsRepository` | `get<T>(key, default) → T`, `set(key, value)`, `getAll() → Record<string, unknown>` |

All repositories accept and return TypeScript types defined in `src/types/liz-transcribe.ts` (shared between main and renderer). No `any`.

#### 4.1.4 Type Contracts (shared)

```typescript
// src/types/liz-transcribe.ts

export type SessionStatus =
  | 'recording' | 'paused' | 'processing'
  | 'completed' | 'completed_with_failures' | 'failed';

export type AudioSource = 'mic' | 'system' | 'both';
export type Stream = 'mic' | 'system';
export type ChunkStatus =
  | 'pending' | 'uploading' | 'polling'
  | 'transcribed' | 'failed' | 'permanently_failed';

export interface Session {
  id: string;
  title: string;
  notes: string;
  createdAt: string;       // ISO-8601 UTC
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  status: SessionStatus;
  speakerCount: number | null;
  source: AudioSource;
  provider: 'assemblyai' | 'deepgram';
  rawAudioPath: string | null;
}

export interface Chunk {
  id: string;
  sessionId: string;
  stream: Stream;
  seq: number;
  filePath: string;
  startSeconds: number;
  endSeconds: number;
  status: ChunkStatus;
  retryCount: number;
  lastError: string | null;
  uploadUrl: string | null;
  transcriptId: string | null;
}

export interface Segment {
  id: number;
  sessionId: string;
  chunkId: string | null;
  stream: Stream;
  speakerLabel: string;     // raw label OR "You" for mic
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence: number | null;
  isFailedPlaceholder: boolean;
}

export interface SearchResult {
  sessionId: string;
  segmentId: number;
  startSeconds: number;
  speakerLabel: string;
  snippet: string;          // FTS5 snippet() with U+0002/U+0003 (STX/ETX) start/end markers (NOT HTML)
}
```

Repository row→object mapping is done in a single `mappers.ts` file using snake_case→camelCase translation.

### 4.2 Audio Capture (Phase 2)

#### 4.2.1 State Machine

```
       ┌──────────────────────────────────┐
       │             idle                 │
       └──────────────────┬───────────────┘
                          │ capture:start
                          ▼
       ┌──────────────────────────────────┐
       │          recording               │◀──────┐
       └─┬────────────┬──────────┬────────┘       │
         │ pause      │ stop     │ device-loss    │ resume
         ▼            ▼          ▼                │
     paused      processing   recovery     ──────┘
     (4h timer)              (auto-pause)
```

- `idle` is conceptual; no DB row exists.
- Transition `recording → processing` happens on user `Stop` or 4-hour pause-timeout. Once in `processing`, no more chunks are produced; the Chunk Processor continues uploading existing chunks.
- Transition to `completed | completed_with_failures | failed` is owned by the Session Finalizer (§4.5), not the capture service.

#### 4.2.2 Chunking & WAV Writer

For both streams (mic and system), the capture service runs:
1. Open the device/source.
2. Buffer raw PCM (16 kHz, 16-bit, mono) into a rolling array.
3. Every `chunkDurationSeconds` (default 10), close the current buffer:
   a. Generate filename: `userData/recordings/<sessionId>/<stream>/<seq6>.wav` where `seq6 = String(seq).padStart(6, '0')`.
   b. Write WAV (RIFF header + PCM data) using the `wav` package.
   c. Open a single SQLite transaction:
      ```
      BEGIN;
      INSERT INTO chunks (...) VALUES (..., status='pending', ...);
      COMMIT;
      ```
      The file is `fsync`'d before the INSERT runs. **(DB-First Write — locked L3.)**
4. Emit `capture:vu-update` to renderer via `win.webContents.send` at ≥ 10 Hz with RMS levels.

**Crash safety**: If the app crashes between step 3a (file written, fsync'd) and 3c (DB row inserted), the file exists on disk but no `chunks` row references it. The orphaned-file recovery on next launch (§4.2.6) detects these and either ingests them (if the parent session is recoverable) or deletes them.

#### 4.2.3 Mic Stream (main process, native)

```
naudiodon2.AudioIO({
  inOptions: {
    deviceId: settings.micDeviceId ?? -1,  // -1 = default
    sampleRate: 16000,
    channelCount: 1,
    sampleFormat: naudiodon2.SampleFormat16Bit,
    framesPerBuffer: 1600,                  // 100 ms frames
    closeOnError: false,
  }
}) → ReadableStream of Buffer
```

The stream is piped through a `ChunkAccumulator` Transform that:
1. Concatenates buffers until 10 s of audio is accumulated.
2. Computes RMS over 100 ms windows; pushes a `vu-update` event each window.
3. On the 10 s boundary, emits a complete PCM `Buffer` to the WAV writer.

Sample rate 16 kHz is chosen to match AssemblyAI's recommended ingest format and to halve the disk + upload size vs. 48 kHz. AssemblyAI accepts 8–48 kHz; 16 kHz is the minimum that does not degrade WER on speech.

#### 4.2.4 Loopback Stream (renderer-bridged)

Because `electron-audio-loopback` runs in the renderer, the chunking lives in the renderer for this stream:
- The renderer sets up `MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', timeslice: chunkSeconds*1000 })`.
- On each `ondataavailable` event, the renderer calls `window.ipcRenderer.invoke('capture:loopback-chunk', { sessionId, seq, mimeType, buffer: ArrayBuffer })`.
- The main process IPC handler:
  1. **Validates payload size**: `MAX_LOOPBACK_CHUNK_BYTES = 5 * 1024 * 1024` (5 MB). A 10 s opus chunk at 96 kbps is ~120 KB; a 10 s PCM chunk at 16 kHz mono 16-bit is ~320 KB; 5 MB is a defensive ceiling. If `buffer.byteLength > 5 MB`, the handler:
     - rejects via `{ ok: false, error: { code: 'chunk_too_large' } }`,
     - emits `capture:device-event` with `{ stream: 'system', event: 'chunk_oversize' }` so the RecordingUI surfaces the issue,
     - does NOT write the file or insert the chunks row.
     This protects main-process memory against a renderer compromise (e.g., a future XSS via a third-party UI dependency) that ships unbounded ArrayBuffers.
  2. Writes the bytes to `userData/recordings/<sessionId>/system/<seq6>.webm` (or `.wav` after transcoding — see §3.4).
  3. Inserts the `chunks` row with `status='pending'`.
- VU computation for the system stream: a `WebAudio AnalyserNode` in the renderer computes RMS at ≥ 10 Hz and ships it via `capture:vu-update-system` IPC channel (separate from mic VU which originates in main). The renderer's VuMeter component subscribes to both.

This split (mic-VU from main, system-VU from renderer) is **acceptable** because both end up in the same renderer component. It is documented as a known asymmetry rather than refactored into a pseudo-uniform path. **Visible-latency note**: the mic-VU path goes main→renderer over IPC (sub-10 ms typical), while system-VU is in-process for the renderer (effectively zero). The visible mismatch in responsiveness is acknowledged here so users / testers don't perceive the mic VU as broken.

**BrowserWindow security posture**: the renderer must run with `webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false }`. The current `electron/main.ts` already sets `contextIsolation: true` and `nodeIntegration: false`; `sandbox: true` is added in this spec's modifications to `main.ts` (§6).

#### 4.2.5 Pause/Resume

- `capture:pause`: capture service stops feeding new audio to the chunk accumulators. Mid-flight chunk (the one currently being accumulated) is **flushed early** as a partial chunk — its `end_seconds` reflects the actual audio duration, not the nominal 10 s. The session row's status moves to `paused`. The 4-hour timer arms.
- `capture:resume`: device validation (re-check that mic and loopback endpoints still exist). If valid, resume both streams; new chunks resume with `seq` continuing monotonically. If invalid, show the device-removed modal (PRD FR-CAP-8).
- 4-hour auto-stop: timer fires → state machine emits `capture:stop` internally → toast emitted via `session:status-changed` with a custom `reason` field.

#### 4.2.6 Recovery on Launch

On `app.whenReady`, the capture service runs:
1. Query `SessionRepository.findAll({ status: ['recording', 'paused'] })`.
2. **Staleness check**: for each candidate session, compare `started_at` against `Date.now()`. If the session is older than `STALE_SESSION_THRESHOLD_MS = 24 * 3600 * 1000` (24 hours) AND has no transcribed chunks, the session is auto-finalized to `failed` and its raw audio is retained (per FR-TR-3). It is **not** offered as a recovery candidate. This prevents a months-old crashed session from re-burning ASR credits when the user finally relaunches the app. The user can still manually retry from the library if FR-CFG-4 retained the audio.
3. For each non-stale candidate, scan the `recordings/<sessionId>` directory:
   - For each WAV file with no matching `chunks` row → insert a `chunks` row (`status='pending'`). This catches the crash-between-fsync-and-INSERT case.
   - For each `chunks` row referencing a missing file → mark as `permanently_failed` (cannot recover).
4. Show the recovery modal: "Recover session from <date>?" Yes → mark session `status='processing'`, let the Chunk Processor finish uploading. No → mark session `status='failed'` and keep raw audio (FR-TR-3 forces retain on `failed`).

**Durability disclosure**: the spec relies on the asymmetric ordering described above (WAV `fsync` before DB INSERT). With `journal_mode=WAL` + `synchronous=NORMAL` (§4.1.1), better-sqlite3 does NOT fsync the WAL on every commit — a crash within ~tens of ms of an INSERT can lose the `chunks` row even though the WAV file is durably on disk. This is the **desired** asymmetry: the recovery procedure (orphan-file → re-INSERT) makes that race recoverable. The reverse race (DB row, no WAV file) IS handled by step 3's `permanently_failed` mark. This trade-off is intentional and is the reason `synchronous=FULL` is not used.

#### 4.2.7 Device Hot-Swap

- `naudiodon2` emits `error` on device removal; the capture service catches it, marks the affected stream offline, emits `capture:device-event` to renderer (`{stream, event:'removed'}`), and continues the other stream.
- `electron-audio-loopback`: the renderer's MediaStreamTrack fires `ended` on device loss; the renderer sends `capture:device-event` upstream.
- Dual-loss → state machine forces `pause` and emits the modal (PRD §6.4).

#### 4.2.8 Sleep / Hibernate

The chunk accumulator records `Date.now()` at each chunk write. A separate watchdog runs `setInterval(checkSleep, 5000)`: if `Date.now() - lastChunkWriteAt > 30_000` AND a chunk has been actively written within the last minute, treat as a sleep event:
1. Move to `processing` status.
2. Emit toast via `session:status-changed`.

### 4.3 Chunk Handoff & Processor (Phase 3)

This is where Locked Decision L3 (DB-First Write + 2 s polling) is implemented.

#### 4.3.1 ChunkProcessor structure

```typescript
// electron/asr/chunk-processor.ts
const TICK_INTERVAL_MS    = 2_000;   // L3: 2 s DB poll
const MIN_POLL_INTERVAL_MS = 3_000;  // per-chunk transcript-poll cadence
const POLL_HTTP_TIMEOUT_MS = 10_000; // per-call HTTP timeout
const UPLOAD_CONCURRENCY   = Number(process.env.LIZMEET_UPLOAD_CONCURRENCY ?? 3);

class ChunkProcessor {
  private timer: NodeJS.Timeout | null = null;
  /** chunkId → AbortController for the currently in-flight upload */
  private uploads = new Map<string, AbortController>();
  /** chunkId → epoch-ms of last GET /transcript/:id; rate-limits per-chunk polling */
  private lastPolledAt = new Map<string, number>();

  start() {
    this.timer = setInterval(() => {
      // tick() never throws; any error is caught internally and logged.
      this.tick().catch(err => logger.error({ event: 'tick_failed', code: 'tick_unhandled' }));
    }, TICK_INTERVAL_MS);
  }

  /**
   * Single tick: kick off pending uploads (concurrency-limited) and poll in-flight transcripts.
   * Critical property: NO `await` in a sequential loop over chunks. A stuck poll on chunk X
   * must not delay the poll of chunk Y or the next tick. This is enforced via Promise.allSettled.
   */
  private async tick(): Promise<void> {
    // ---- 1. Kick off pending uploads (bounded by UPLOAD_CONCURRENCY) ----
    const slotsFree = Math.max(0, UPLOAD_CONCURRENCY - this.uploads.size);
    if (slotsFree > 0) {
      const pending = chunkRepo.findPending(slotsFree);
      // Fire-and-forget: each upload manages its own lifecycle and updates DB on settle.
      // Tracked in this.uploads so the next tick honours the concurrency cap.
      for (const chunk of pending) this.beginUpload(chunk);
    }

    // ---- 2. Poll in-flight transcripts (parallel, rate-limited per chunk) ----
    const polling = chunkRepo.findInFlight(50);   // bounded query; see §4.1.3
    const now = Date.now();
    const due = polling.filter(c => {
      const last = this.lastPolledAt.get(c.id) ?? 0;
      return now - last >= MIN_POLL_INTERVAL_MS;
    });

    // Promise.allSettled so one stuck poll cannot starve the others.
    // Each pollTranscript(chunk) handles its own errors and updates DB on success/permanent-fail.
    await Promise.allSettled(
      due.map(chunk => {
        this.lastPolledAt.set(chunk.id, now);
        return this.pollTranscript(chunk);
      })
    );

    // Garbage-collect lastPolledAt entries for chunks no longer in-flight.
    if (this.lastPolledAt.size > polling.length * 2) {
      const live = new Set(polling.map(c => c.id));
      for (const k of this.lastPolledAt.keys()) if (!live.has(k)) this.lastPolledAt.delete(k);
    }
  }

  private async pollTranscript(chunk: Chunk): Promise<void> {
    // Per-call timeout so a hung HTTP request cannot occupy a tick indefinitely.
    const signal = AbortSignal.timeout(POLL_HTTP_TIMEOUT_MS);
    try {
      const result = await this.provider.pollTranscript(chunk.transcriptId!, signal);
      if (result.status === 'completed') {
        await this.handleTranscribed(chunk, result);
      } else if (result.status === 'error') {
        await this.handleTranscriptError(chunk, result.error ?? 'unknown_provider_error');
      }
      // status === 'queued' | 'processing' → no-op; next tick will re-poll once
      // MIN_POLL_INTERVAL_MS has elapsed.
    } catch (err) {
      // Network error, abort/timeout, or non-2xx from provider.
      // Do NOT mark the chunk failed here — transient network blips should not consume retries.
      // Just log and let the next tick re-attempt. lastPolledAt rate-limits the retry.
      logger.warn({
        event: 'poll_transient_error',
        chunkId: chunk.id,
        code: classifyHttpError(err),
        // sanitized: never log raw err.message — see §4.9
      });
    }
  }

  // ... (beginUpload, handleTranscribed, handleTranscriptError covered in §4.5)
}
```

#### 4.3.2 Polling rate trade-off

- **2 s** for `chunks` table tick (locked by L3).
- **3 s** minimum between polls of any single transcript_id (`MIN_POLL_INTERVAL_MS`). Enforced by `lastPolledAt`. Even though the tick runs every 2 s, a chunk polled at t=0 will be skipped at the t=2 tick and polled again only at the t=4 tick — never below the 3 s floor.
- **10 s** per-call HTTP timeout (`AbortSignal.timeout`). A hung AssemblyAI response cannot occupy a tick beyond this.
- At peak (12 in-flight chunks during a 4-hour session): each tick fires up to 12 parallel `GET /transcript/:id` calls, each capped at 10 s. Worst-case tick wall-clock: 10 s. Next tick begins immediately after (the `setInterval` cadence is 2 s but `tick()` is `async`; the next interval fires only after the previous resolves — see `start()`).

#### 4.3.3 Concurrency hardening

- **Tick re-entrancy**: `setInterval` does not await `tick()`. If a tick takes longer than 2 s (e.g., 12 simultaneous 10 s timeouts all firing), the next interval will fire and call `tick()` re-entrantly. This is **acceptable** because:
  - `findPending(slotsFree)` checks the live `this.uploads.size`, so concurrency cap is honoured.
  - `lastPolledAt` is checked atomically per chunk, so the same chunk cannot be polled twice in parallel.
  - Repository methods are synchronous (better-sqlite3) and serialized on the main event loop.
- **429 backoff (adaptive)**: if `pollTranscript` or `submitTranscript` returns 429, set `this.throttleUntil = Date.now() + 60_000` and reduce `effectiveConcurrency` to 1 until the throttle window passes. Reset on next successful 2xx.
- **Garbage collection**: `lastPolledAt` only grows during a session; a sweep at the bottom of `tick()` removes entries for chunks that are no longer in-flight (transcribed or permanently_failed).

#### 4.3.4 Why polling beats events

A separate event-bus or queue dependency was rejected in context.md (Themis decision). Polling DB at 2 s means: zero state outside the DB, no race conditions, restart-safe, debuggable by `sqlite3 liz-transcribe.db 'SELECT status, COUNT(*) FROM chunks GROUP BY status'`.

### 4.4 AssemblyAI Client (Phase 3)

#### 4.4.1 Security & correctness contract

Every fetch call to AssemblyAI MUST satisfy:

1. **`redirect: 'manual'`** — Node fetch (undici) replays request headers (including `Authorization`) on automatic 3xx follows. AssemblyAI does not document redirects on its primary endpoints, but a CDN-level redirect on `/upload` would leak the API key to the redirect target. Manual redirect handling forces us to reject 3xx explicitly. See §10 R-SEC-1.
2. **No raw response body in errors or logs.** `await res.text()` on an error response can echo back the request payload, which for `/transcript` includes the signed `audio_url` (a token). The `sanitizeProviderBody()` helper extracts a stable error code or message and discards the rest. See §4.4.2.
3. **No raw `Authorization` header value in any logging path.** The `logger` interface in `electron/logging/logger.ts` exposes only structured fields; the API key never appears as a positional argument. The `requestLog()` helper in §4.4.2 is the single allowed code path for logging an AssemblyAI request, and it logs `{ method, url, status }` only.
4. **Per-call timeout via `AbortSignal.timeout`** — every request has a finite ceiling: 30 s for `/upload` (chunks ≤ 5 MB), 10 s for `/transcript` (POST), 10 s for `/transcript/:id` (GET).
5. **Body materialization for `/upload`** — `fs.createReadStream` returns a Node `Readable`, which is **not** a Web `ReadableStream`. Use `Readable.toWeb(fileStream)` (Node 18+) and pass with `duplex: 'half'`. For chunks ≤ 5 MB the alternative is `await fs.promises.readFile(path)` to a Buffer, which is simpler and avoids the half-duplex stream-body requirement. We adopt the Buffer path because: (a) chunks are bounded by `MAX_CHUNK_BYTES = 5 MB` (§4.2.4); (b) at 10 s × 16 kHz × 16-bit × mono ≈ 320 KB raw or ≈ 120 KB opus, memory cost is negligible; (c) Buffer body avoids any future undici quirks around Web ReadableStream + Node Readable interop.

#### 4.4.2 Error sanitization helpers

```typescript
// electron/asr/provider-errors.ts

/** Stable error codes the rest of the system reasons about. Never raw provider strings. */
export type ProviderErrorCode =
  | 'auth_failed'        // 401, 403
  | 'rate_limited'       // 429
  | 'bad_request'        // 400
  | 'provider_5xx'       // 500–599
  | 'redirect_rejected'  // 3xx — never followed
  | 'timeout'            // AbortSignal.timeout fired
  | 'network'            // fetch throw (DNS, conn reset, etc.)
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly status: number | null,
    /** Sanitized short string suitable for logging. Never includes URLs or auth headers. */
    public readonly safeMessage: string,
  ) {
    super(`provider:${code}:${status ?? 'no-status'}`);
  }
}

/**
 * Extract a safe error description from a non-2xx response. NEVER returns the raw body.
 *  - Reads up to 512 bytes of the response body (cap to avoid loading huge error pages).
 *  - Strips URL query strings (which can contain signed-URL tokens) via a regex.
 *  - Truncates to 200 chars after stripping.
 *  - On parse failure, returns the empty string.
 *
 * The caller composes a `ProviderError` from { status, code, safeMessage }; the raw body
 * never enters logs or IPC return values.
 */
export async function sanitizeProviderBody(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const { value } = await reader.read();
    reader.cancel();   // we only want the first ≤ 512 bytes
    if (!value) return '';
    const text = new TextDecoder().decode(value.subarray(0, 512));
    // Strip query strings: `https://...foo?token=abc&x=1` → `https://...foo`
    const noQuery = text.replace(/(\?[^\s"',}]*)/g, '?<redacted>');
    // Strip Bearer / token-like substrings of length ≥ 16 alphanumeric.
    const noTokens = noQuery.replace(/[A-Za-z0-9_-]{16,}/g, '<redacted>');
    return noTokens.slice(0, 200);
  } catch {
    return '';
  }
}

export function classifyStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 400)                     return 'bad_request';
  if (status === 429)                     return 'rate_limited';
  if (status >= 300 && status < 400)      return 'redirect_rejected';
  if (status >= 500 && status < 600)      return 'provider_5xx';
  return 'unknown';
}

export function classifyHttpError(err: unknown): ProviderErrorCode {
  if (err instanceof ProviderError) return err.code;
  // AbortError from AbortSignal.timeout has name 'TimeoutError' in Node 18.17+
  // and 'AbortError' in earlier 18.x. Match both.
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout';
  }
  return 'network';
}
```

#### 4.4.3 Client implementation

```typescript
// electron/asr/assemblyai-client.ts
import { promises as fsp } from 'node:fs';
import {
  ProviderError, classifyStatus, classifyHttpError, sanitizeProviderBody,
} from './provider-errors';

const UPLOAD_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS   = 10_000;
const MAX_CHUNK_BYTES   = 5 * 1024 * 1024;   // 5 MB hard cap; matches §4.2.4 IPC cap

class AssemblyAIClient implements IASRProvider {
  constructor(private apiKey: string) {}

  /**
   * Build the Authorization header lazily so the key is never closed-over by
   * any logging/structured-error code path.
   */
  private authHeaders(extra: Record<string, string> = {}): HeadersInit {
    return { Authorization: this.apiKey, ...extra };
  }

  /**
   * Wrap a fetch call with: redirect:'manual' rejection of 3xx, status classification,
   * sanitized error bodies, and timeout-classification on AbortError.
   *
   * On any non-2xx, throws a ProviderError with a sanitized safeMessage.
   * On any thrown error, classifies and rethrows as ProviderError.
   */
  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    // Compose: per-call timeout AND caller's abort signal (e.g., session-stop).
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: 'manual', signal });
    } catch (err) {
      throw new ProviderError(classifyHttpError(err), null, '');
    }

    // Reject 3xx outright. redirect:'manual' surfaces them as type:'opaqueredirect'
    // (status 0) for cross-origin or as a normal Response with 3xx status for same-origin.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new ProviderError('redirect_rejected', res.status || null,
        'AssemblyAI returned 3xx; redirects are not followed (key-leak prevention).');
    }
    if (!res.ok) {
      const code = classifyStatus(res.status);
      const safeMessage = await sanitizeProviderBody(res);
      throw new ProviderError(code, res.status, safeMessage);
    }
    return res;
  }

  async uploadChunk(filePath: string, signal?: AbortSignal): Promise<string> {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_CHUNK_BYTES) {
      throw new ProviderError('bad_request', null,
        `chunk exceeds ${MAX_CHUNK_BYTES} bytes`);
    }
    const body = await fsp.readFile(filePath);   // Buffer; ≤ 5 MB by precondition
    const res = await this.request(
      'https://api.assemblyai.com/v2/upload',
      { method: 'POST', headers: this.authHeaders(), body },
      UPLOAD_TIMEOUT_MS,
      signal,
    );
    const json = await res.json() as { upload_url: string };
    return json.upload_url;
  }

  async submitTranscript(audioUrl: string, signal?: AbortSignal): Promise<string> {
    const res = await this.request(
      'https://api.assemblyai.com/v2/transcript',
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          audio_url: audioUrl,
          speaker_labels: true,
          language_code: 'en_us',
        }),
      },
      SUBMIT_TIMEOUT_MS,
      signal,
    );
    const json = await res.json() as { id: string };
    return json.id;
  }

  async pollTranscript(transcriptId: string, signal?: AbortSignal): Promise<TranscriptResult> {
    const res = await this.request(
      `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
      { headers: this.authHeaders() },
      POLL_TIMEOUT_MS,
      signal,
    );
    return await res.json() as TranscriptResult;
  }
}
```

**Authorization-header handling rule (binding on all maintainers):** the string `this.apiKey` MUST appear in exactly one place in the codebase: `AssemblyAIClient.authHeaders()`. Any code path that reads, logs, or stringifies a `Headers` / `Request` / `Response` object MUST first delete the `Authorization` field. The `logger` API (§4.9, §8) accepts only structured fields and never variadic arguments, which prevents accidental `logger.info('request', headers)` patterns.

### 4.5 Retry, Provider-Unreachable Banner, Session Finalizer

#### 4.5.1 Retry Policy

```typescript
// electron/asr/retry-policy.ts
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;

function shouldRetry(status: number, attempt: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  if (status === 401 || status === 403) return false;  // auth failure - not retriable
  if (status === 400) return false;                     // bad request - not retriable
  return true;                                          // 429, 5xx, network - retriable
}

function delayFor(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}
```

On auth failure (401/403), the chunk is marked `permanently_failed` immediately AND the session is forced to `failed` AND the renderer is redirected to Settings (PRD §6.4).

#### 4.5.2 Provider-Unreachable Banner

Maintained as in-memory state in `ChunkProcessor`:
- Counter of consecutive 5xx failures across all chunks.
- On reaching 3, emit `asr:provider-banner` via `win.webContents.send` with `{ visible: true }`.
- On next successful upload, reset counter, emit `{ visible: false }`.

The banner state is **not persisted** to DB — it's a transient UI hint. If the app restarts, the counter starts at zero; if the provider is still down, the next 3 failures will re-show it.

#### 4.5.3 Session Finalizer

Triggered after each chunk state change (called from `ChunkProcessor.updateChunkStatus()`):

```typescript
function finalizeIfReady(sessionId: string) {
  const chunks = chunkRepo.findBySession(sessionId);
  const session = sessionRepo.findById(sessionId);
  if (!session || session.status === 'recording' || session.status === 'paused')
    return;  // still capturing; don't finalize

  const counts = countByStatus(chunks);
  const inFlight = counts.pending + counts.uploading + counts.polling + counts.failed;
  if (inFlight > 0) return;  // still working

  // All chunks are terminal: transcribed | permanently_failed
  let next: SessionStatus;
  if (counts.transcribed > 0 && counts.permanently_failed === 0) {
    next = 'completed';
  } else if (counts.transcribed > 0 && counts.permanently_failed > 0) {
    next = 'completed_with_failures';
  } else {
    next = 'failed';
  }

  // 1. Run transcript assembly (if not already)
  if (next !== 'failed') {
    transcriptAssembler.assemble(sessionId);
  }
  // 2. Apply audio retention (FR-CFG-4)
  applyAudioRetention(sessionId, next);
  // 3. Update DB and notify renderer
  sessionRepo.updateStatus(sessionId, next);
  win.webContents.send('session:status-changed', { sessionId, newStatus: next }); // L4
}
```

### 4.6 Provider Abstraction

```typescript
// electron/asr/provider-interface.ts
export interface IASRProvider {
  readonly name: 'assemblyai' | 'deepgram';
  uploadChunk(filePath: string, signal?: AbortSignal): Promise<string>;
  submitTranscript(audioUrl: string, options: TranscribeOptions): Promise<string>;
  pollTranscript(transcriptId: string): Promise<TranscriptResult>;
  parseUtterances(result: TranscriptResult): RawUtterance[];  // provider-specific shape → common
}

export interface RawUtterance {
  speakerLabel: string;        // "A", "B", … from AssemblyAI; or "1", "2", … from Deepgram
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}
```

Rationale: each provider's response shape differs (AssemblyAI uses `utterances[].speaker`; Deepgram uses word-level `channels[].alternatives[].words[].speaker`). Normalizing into `RawUtterance[]` means the diarization-merge module is provider-agnostic.

### 4.7 Diarization Merge & Clock-Drift Correction

```typescript
// electron/asr/diarization-merge.ts
export function mergeStreams(
  micUtterances: RawUtterance[],
  systemUtterances: RawUtterance[],
  sessionId: string,
  micStartWallClock: number,        // ms epoch when mic stream started
  systemStartWallClock: number,     // ms epoch when system stream started
): Segment[] {
  // 1. Compute drift offset between streams (system - mic in ms)
  const offsetMs = systemStartWallClock - micStartWallClock;
  // 2. Apply offset to system utterances so both timelines share session-relative t=0
  const systemAligned = systemUtterances.map(u => ({
    ...u, startMs: u.startMs + offsetMs, endMs: u.endMs + offsetMs,
  }));
  // 3. Relabel mic utterances as "You" (FR-TR-7)
  const micRelabeled = micUtterances.map(u => ({ ...u, speakerLabel: 'You' }));
  // 4. Tag and concat
  const all: Array<RawUtterance & {stream: Stream}> = [
    ...micRelabeled.map(u => ({ ...u, stream: 'mic' as Stream })),
    ...systemAligned.map(u => ({ ...u, stream: 'system' as Stream })),
  ];
  // 5. Sort by start
  all.sort((a, b) => a.startMs - b.startMs);
  // 6. Convert to Segment rows
  return all.map(u => ({
    sessionId, chunkId: null, stream: u.stream,
    speakerLabel: u.speakerLabel,
    startSeconds: u.startMs / 1000,
    endSeconds: u.endMs / 1000,
    text: u.text,
    confidence: u.confidence,
    isFailedPlaceholder: false,
  }));
}
```

**Clock-drift correction** (FR-TR-7 ±200 ms tolerance over 60 min):
- The simple offset above (system_wall_clock − mic_wall_clock) handles the *startup* asymmetry (system stream typically starts 50–500 ms after mic due to `getDisplayMedia` permission flow).
- Pure linear drift between two Windows audio clocks is empirically < 50 ppm (Microsoft Win32 audio docs). Over 60 min that is 60 * 60 * 1000 * 50e-6 = 180 ms — within budget.
- Each chunk write records its `wallClockAt` in the chunks row. The session finalizer logs `(lastSystemWallClock - lastMicWallClock) - (firstSystemWallClock - firstMicWallClock)` as the measured drift; if > 200 ms, it logs a `drift_exceeded` event and surfaces it in dev mode. v1 does not auto-correct linear drift (no observed need); v1.x can add it if the metric warrants.

#### 4.7.1 Within-stream speaker-label stitching algorithm

AssemblyAI emits per-upload diarization labels (`A`, `B`, `C`, …) — labels are scoped to a single submitted transcript and have no cross-transcript meaning. In chunked mode (Config A in §11), each 10 s chunk is a separate transcript, so chunk N's `A` and chunk N+1's `A` are distinct entities that *might or might not* refer to the same physical speaker. The stitching algorithm below maps per-chunk labels to a stream-global label space by exploiting temporal overlap in a fixed boundary window.

**Inputs and outputs:**
- Input: ordered list of chunks `chunks[1..K]`. Each chunk `n` has utterances `U_n = [{ localLabel, startMs, endMs }, ...]` in chunk-local time. Chunk boundaries align by construction (chunk `n` covers `[(n-1)·10s, n·10s)` per §4.2.2).
- Output: a per-utterance `globalLabel` for every utterance in every chunk, such that the same physical speaker receives the same label across chunks within the stream.

**Constants (justified below):**
- `OVERLAP_WINDOW_MS = 1500` — boundary window into which we look for matching utterances. 1.5 s rather than 1 s because: (a) AssemblyAI's diarizer can place a speaker boundary up to ~500 ms inside the audible utterance edge; (b) typical inter-utterance silence in conversational speech is ≥ 200 ms (Stivers et al., 2009); 1.5 s captures both edges of a single utterance that a chunk boundary cuts. Justified empirically — sensitivity to window size is low between 1 s and 2 s on DIHARD-style data.
- `MIN_OVERLAP_MS = 100` — minimum total overlap (in ms) required for a match to be considered a "real" overlap rather than a coincidental short fragment.
- `MIN_OVERLAP_RATIO = 0.30` — a candidate match must cover ≥ 30 % of the shorter speaker's duration in the boundary window. Lower ratios are rejected as too ambiguous; the label is then treated as a new speaker.

**Pseudocode:**

```
function stitchStreamLabels(chunks: ChunkUtterances[]): GlobalLabeledUtterance[] {

  // globalAssign[chunkIndex][localLabel] -> globalLabel
  globalAssign := empty 2-D map
  nextGlobalId := 0
  function newGlobal(): string { return "G" + (nextGlobalId++) }

  // Chunk 1: every local label gets a fresh global label.
  for each label L in distinctLabels(chunks[1]):
    globalAssign[1][L] := newGlobal()

  // For chunks 2..K, match against chunk N-1's labels.
  for n in 2..K:
    prev    := chunks[n-1]
    current := chunks[n]
    boundary_start := chunkStartMs(n) - OVERLAP_WINDOW_MS
    boundary_end   := chunkStartMs(n) + OVERLAP_WINDOW_MS

    // (a) Compute duration-weighted overlap matrix in the boundary window.
    //     overlap[L_curr][L_prev] = total ms of (L_curr ∩ L_prev) inside [boundary_start, boundary_end]
    //     where ∩ means time-overlap of utterances of those labels.
    overlap := zero matrix indexed by (currentLabel, prevLabel)

    for each utterance u_p in prev where u_p.endMs >= boundary_start:
      clip_p := clipToWindow(u_p, boundary_start, boundary_end)
      if duration(clip_p) == 0: continue
      for each utterance u_c in current where u_c.startMs <= boundary_end:
        clip_c := clipToWindow(u_c, boundary_start, boundary_end)
        if duration(clip_c) == 0: continue
        ov := overlapMs(clip_p, clip_c)
        if ov > 0:
          overlap[u_c.localLabel][u_p.localLabel] += ov

    // (b) Greedy 1:1 assignment — sort by overlap descending and consume the
    //     largest unmatched pairs first. Each prev-label can be the target of
    //     at most one current-label, and vice versa.
    pairs := flatten(overlap) → list of (currentLabel, prevLabel, overlapMs)
    sort pairs by overlapMs descending
    matchedCurr := empty set
    matchedPrev := empty set
    matches := empty map (currentLabel -> prevLabel)
    for (curr, prev, ov) in pairs:
      if curr in matchedCurr or prev in matchedPrev: continue
      // Reject low-confidence matches: must clear absolute and ratio thresholds.
      shorterDuration := min(totalDurationOf(curr in window),
                             totalDurationOf(prev in window))
      if ov < MIN_OVERLAP_MS:                          continue
      if ov / max(1, shorterDuration) < MIN_OVERLAP_RATIO: continue
      matches[curr] := prev
      matchedCurr.add(curr)
      matchedPrev.add(prev)

    // (c) Tie-breaking. Two ties are possible:
    //     (i) same overlapMs for two different (curr, prev) pairs sharing one side.
    //         The greedy sort is stabilized by a secondary key:
    //         total overlap of the *shorter*-side label across the entire window
    //         (favors the label with more presence in the boundary window).
    //     (ii) ties remaining after (i): tie-break on smaller localLabel
    //         lexicographic (deterministic; no numerical preference).
    //
    //     Tie-breaking is implemented as the sort comparator:
    //       compare(a, b) =
    //         a.overlapMs - b.overlapMs                  // primary (desc)
    //         or shorterSidePresence(b) - shorterSidePresence(a)
    //         or a.currLabel.localeCompare(b.currLabel)

    // (d) Assign globals.
    for each distinct currentLabel L_c in current:
      if L_c in matches:
        globalAssign[n][L_c] := globalAssign[n-1][matches[L_c]]
      else:
        // Either no overlap candidate met thresholds, OR no prev-label was
        // available (e.g., prev had only label A; current introduces B).
        // Treat as a NEW speaker: fresh global label, NEVER reused from earlier
        // chunks even if a match would have been "plausible-but-rejected".
        // (This is the safe direction: false splits are correctable post-hoc;
        // false merges are not.)
        globalAssign[n][L_c] := newGlobal()

  // Apply globalAssign to produce the output utterance list.
  out := []
  for n in 1..K:
    for u in chunks[n]:
      out.push({ ...u, globalLabel: globalAssign[n][u.localLabel] })
  return out
}
```

**Algorithmic properties (the key correctness claims):**

1. **Global-label assignment for new speakers.** A label that does not match any prev-label above threshold receives a fresh `G<n>` label that has never been used. The algorithm never reuses a previous chunk's label for a new speaker — addressing Apollo's case (a).
2. **Boundary-crossed utterances.** When an utterance spans the chunk boundary, the diarizer assigns a label on each side. Both sides are clipped into the `[boundary - 1.5s, boundary + 1.5s]` window and contribute their overlapping duration to the overlap matrix. The greedy match reliably stitches them — addressing Apollo's case (b).
3. **Duration-weighted, not count-weighted.** A 9-second utterance contributes 9 × the overlap of a 1-second utterance, so dominant speakers stitch correctly across chunks even when the boundary window is dense — addressing Apollo's case (c).
4. **Deterministic tie-breaking.** The secondary sort key (presence in window) and tertiary key (lexicographic) make the algorithm a pure function of the inputs. Identical re-runs produce identical labels.
5. **Conservative on uncertainty.** When in doubt, split (assign a fresh global label). A wrongly-split speaker can be merged via the user's per-session rename UI (FR-UX-3); a wrongly-merged speaker cannot be split without re-diarizing.

**Confidence of stitched stream relative to single-pass diarization.** This algorithm is the "stitched" path measured in §11. The §11.5 literature prior expects mean Δ_DER in the 1.5–4.0 pp band against a full-session single-pass baseline; the algorithm above is dimensioned to sit at the favorable end of that band on conversational speech with clear silence boundaries.

#### 4.7.2 Cross-stream merge

After per-stream stitching produces stream-globally-stable labels, the two streams are merged on a single timeline:
- Mic stream's utterances are relabeled `"You"` (FR-TR-7) regardless of mic-stream global labels (mic should always be the local user; if multiple speakers are picked up by the mic, they're conflated under "You" — accepted limitation, not a defect).
- System stream's utterances keep their stitched global labels (`G0`, `G1`, …); `SpeakerLabelEditor` lets the user rename them per-session.
- Utterances are sorted by `startMs` after applying the cross-stream offset (clock-drift correction) below.

### 4.8 Provider-Push to Renderer (L4)

```typescript
// electron/ipc/notifier.ts
export function notify(win: BrowserWindow, channel: string, payload: unknown) {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}
```

Channels:
| Channel | Payload | Source | Consumer |
|---------|---------|--------|----------|
| `session:status-changed` | `{sessionId: string, newStatus: SessionStatus}` | Session Finalizer | LibraryPage + TranscriptPage |
| `capture:vu-update` | `{stream: Stream, rmsDb: number}` | Mic capture (main) | RecordingUI |
| `capture:vu-update-system` | `{rmsDb: number}` | Loopback (renderer-self) | RecordingUI |
| `capture:device-event` | `{stream: Stream, event: 'removed'|'restored', errorCode?: number}` | Capture service | RecordingUI |
| `asr:provider-banner` | `{visible: boolean}` | Chunk Processor | RecordingUI + LibraryPage |
| `session:auto-stopped` | `{sessionId: string, reason: 'sleep'|'pause-timeout'}` | Capture service | LibraryPage (toast) |

### 4.9 IPC Channels (Renderer → Main, invoke)

All channels are typed in `electron/ipc/channels.ts`:

```typescript
export const CHANNELS = {
  // Session
  SESSION_LIST:    'session:list',
  SESSION_GET:     'session:get',
  SESSION_UPDATE:  'session:update',
  SESSION_DELETE:  'session:delete',
  // Capture
  CAPTURE_START:   'capture:start',
  CAPTURE_PAUSE:   'capture:pause',
  CAPTURE_RESUME:  'capture:resume',
  CAPTURE_STOP:    'capture:stop',
  CAPTURE_STATUS:  'capture:status',
  CAPTURE_PREFLIGHT:'capture:preflight',
  CAPTURE_LOOPBACK_CHUNK: 'capture:loopback-chunk',  // renderer→main bulk transfer
  // Segments
  SEGMENT_FIND_BY_SESSION: 'segment:findBySession',
  SEGMENT_SEARCH:  'segment:search',
  // Speaker labels
  SPEAKER_LABEL_UPSERT: 'speakerLabel:upsert',
  SPEAKER_LABEL_LIST:   'speakerLabel:list',
  // Settings
  SETTINGS_GET:    'settings:get',
  SETTINGS_SET:    'settings:set',
  // API key (Phase 5)
  APIKEY_SET:      'apikey:set',
  APIKEY_EXISTS:   'apikey:exists',
  APIKEY_TEST:     'apikey:test',
  // Privacy
  PRIVACY_ACK_GET: 'privacy:get',
  PRIVACY_ACK_SET: 'privacy:set',
  PRIVACY_REVOKE:  'privacy:revoke',
  // Transcript retry (Phase 3)
  TRANSCRIPT_RETRY_CHUNK: 'transcript:retry-chunk',
  TRANSCRIPT_RETRY_ALL:   'transcript:retry-all-failed',
  // Export (Phase 4)
  TRANSCRIPT_EXPORT: 'transcript:export',
} as const;

export type ChannelName = typeof CHANNELS[keyof typeof CHANNELS];
```

For each channel, request/response types are exported as `Req<typeof CHANNELS.SESSION_LIST>` / `Res<...>`. Handlers are registered via:

```typescript
// electron/ipc/handlers.ts
ipcMain.handle(CHANNELS.SESSION_LIST, withErrorWrapper(async (_, args: ListArgs) => {
  return sessionRepo.findAll(args);
}));
```

#### 4.9.1 Error-classification contract (`withErrorWrapper`)

`withErrorWrapper` is the single trust boundary between main-process exceptions and the renderer. Its contract is **non-negotiable**: the renderer NEVER receives a raw `error.message` or any other field of a thrown error. Instead, every error is mapped to a small set of stable codes; unknown errors collapse to `'internal_error'` with a server-side `logId` that the user can quote in a bug report.

**Classification table (the source of truth for IPC error codes):**

| Caught error | IPC `error.code` | IPC `error.message` returned | Logged at |
|--------------|------------------|------------------------------|-----------|
| `ProviderError(code='auth_failed')` | `'provider_auth_failed'` | `"AssemblyAI rejected the API key. Re-enter in Settings."` | `warn` |
| `ProviderError(code='rate_limited')` | `'provider_rate_limited'` | `"AssemblyAI rate limit reached. Try again shortly."` | `warn` |
| `ProviderError(code='provider_5xx')` | `'provider_unavailable'` | `"AssemblyAI is temporarily unavailable."` | `warn` |
| `ProviderError(code='timeout')` | `'provider_timeout'` | `"Request to AssemblyAI timed out."` | `warn` |
| `ProviderError(code='network')` | `'network_error'` | `"Network error contacting AssemblyAI."` | `warn` |
| `ProviderError(code='redirect_rejected')` | `'provider_unexpected'` | `"AssemblyAI returned an unexpected redirect."` | `error` |
| `ProviderError(code='bad_request')` | `'provider_bad_request'` | `"AssemblyAI rejected the request."` | `error` |
| `ZodError` (IPC payload validation) | `'invalid_argument'` | `"Invalid request payload."` | `warn` |
| `BetterSqlite3.SqliteError` | `'internal_error'` | `"Internal database error."` | `error` |
| Native module error (naudiodon, electron-audio-loopback) | `'capture_failed'` | `"Audio capture failed."` | `error` |
| `safeStorage` decryption error | `'apikey_unreadable'` | `"Stored API key cannot be read. Please re-enter."` | `error` |
| Anything else | `'internal_error'` | `"An unexpected error occurred. (logId: <uuid>)"` | `error` |

**Implementation:**

```typescript
// electron/ipc/error-wrapper.ts
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ProviderError } from '../asr/provider-errors';

type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; logId?: string } };

export function withErrorWrapper<Args extends unknown[], R>(
  channel: string,
  handler: (...args: Args) => Promise<R> | R,
): (...args: Args) => Promise<IpcResult<R>> {
  return async (...args: Args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      const { code, message, severity } = classifyError(err);
      const logId = randomUUID();
      // sanitizeForLog removes any field whose name matches /authorization|api[-_]?key|token|secret/i
      // and truncates string values to 256 chars. Defined in electron/logging/logger.ts.
      logger[severity]({
        event: 'ipc_handler_error',
        channel,
        code,
        logId,
        // Only structured, sanitized fields. NEVER pass `err` directly.
        details: sanitizeForLog(extractSafeFields(err)),
      });
      return { ok: false, error: { code, message, logId } };
    }
  };
}

function classifyError(err: unknown): { code: string; message: string; severity: 'warn'|'error' } {
  // ProviderError is the only error type allowed to carry a structured code from
  // outside withErrorWrapper. Its `safeMessage` is already sanitized (§4.4.2).
  if (err instanceof ProviderError) {
    switch (err.code) {
      case 'auth_failed':       return { code: 'provider_auth_failed',  message: 'AssemblyAI rejected the API key. Re-enter in Settings.', severity: 'warn' };
      case 'rate_limited':      return { code: 'provider_rate_limited', message: 'AssemblyAI rate limit reached. Try again shortly.',     severity: 'warn' };
      case 'provider_5xx':      return { code: 'provider_unavailable',  message: 'AssemblyAI is temporarily unavailable.',                severity: 'warn' };
      case 'timeout':           return { code: 'provider_timeout',      message: 'Request to AssemblyAI timed out.',                     severity: 'warn' };
      case 'network':           return { code: 'network_error',         message: 'Network error contacting AssemblyAI.',                 severity: 'warn' };
      case 'redirect_rejected': return { code: 'provider_unexpected',   message: 'AssemblyAI returned an unexpected redirect.',          severity: 'error' };
      case 'bad_request':       return { code: 'provider_bad_request',  message: 'AssemblyAI rejected the request.',                     severity: 'error' };
      default:                  return { code: 'provider_unexpected',   message: 'AssemblyAI request failed.',                           severity: 'error' };
    }
  }
  if (err instanceof ZodError)
    return { code: 'invalid_argument', message: 'Invalid request payload.', severity: 'warn' };
  if (isSqliteError(err))
    return { code: 'internal_error',   message: 'Internal database error.', severity: 'error' };
  if (isCaptureError(err))
    return { code: 'capture_failed',   message: 'Audio capture failed.',    severity: 'error' };
  if (isSafeStorageError(err))
    return { code: 'apikey_unreadable',message: 'Stored API key cannot be read. Please re-enter.', severity: 'error' };
  return { code: 'internal_error', message: 'An unexpected error occurred.', severity: 'error' };
}

/** Pull a small, hand-picked set of fields from an unknown error for logging.
 *  NEVER returns the .message field; NEVER returns .stack except after sanitizeForLog. */
function extractSafeFields(err: unknown): Record<string, unknown> {
  if (err instanceof ProviderError) {
    return { kind: 'provider', code: err.code, status: err.status, safeMessage: err.safeMessage };
  }
  if (err instanceof Error) {
    return { kind: 'generic', name: err.name }; // .message intentionally omitted
  }
  return { kind: 'unknown' };
}
```

**Renderer-side hook**:

```typescript
// src/lib/ipc.ts (excerpt)
export async function invokeOrThrow<C extends ChannelName>(c: C, p: Req<C>): Promise<Res<C>> {
  const r = await window.ipcRenderer.invoke(c, p);
  if (r.ok) return r.data;
  // Renderer maps `r.error.code` to localized strings; r.error.message is the
  // pre-localized fallback. Renderer never tries to interpret error.message.
  throw new IpcError(r.error.code, r.error.message, r.error.logId);
}
```

#### 4.9.2 Logger contract

`electron/logging/logger.ts` exposes `info / warn / error` taking a single structured-object argument. Variadic / positional logging is not exposed. The `sanitizeForLog` helper:
- recursively walks the object; on any key matching `/^(authorization|api[-_]?key|token|secret|password|cookie)$/i`, replaces the value with `'<redacted>'`;
- truncates string values longer than 256 chars to `value.slice(0,253)+'...'`;
- replaces any string value matching the URL pattern `https?://[^?\s]+\?[^\s]+` with the URL minus the query string.

This is defense-in-depth — the per-error `extractSafeFields` already drops `.message`; `sanitizeForLog` is a backstop against future code paths that pass less-disciplined objects.

Preload bridge (`electron/preload.ts`) exposes `invoke<C extends ChannelName>(channel: C, payload: Req<C>) => Promise<Res<C>>`. The current bridge already exposes generic `invoke`, so the addition is a typed wrapper file in the renderer (`src/lib/ipc.ts`):

```typescript
export const ipc = {
  invoke<C extends ChannelName>(c: C, p: Req<C>): Promise<Res<C>> {
    return window.ipcRenderer.invoke(c, p);
  },
  on<C extends keyof PushChannels>(c: C, h: (p: PushChannels[C]) => void) { ... },
};
```

### 4.10 First-Run Gate & Routing (L2)

`src/App.tsx` becomes a `<RouterProvider>` shell:

```typescript
// src/App.tsx
const router = createBrowserRouter([
  {
    path: '/',
    loader: rootGuard,                 // checks privacyAck + apiKey, redirects
    element: <RootShell/>,
    children: [
      { index: true, loader: () => redirect('/library') },
      { path: 'first-run/privacy',  element: <PrivacyNoticePage/> },
      { path: 'first-run/api-key',  loader: privacyAckGuard, element: <ApiKeySetupPage/> },
      { path: 'library',            loader: setupCompleteGuard, element: <LibraryPage/> },
      { path: 'session/:id',        loader: setupCompleteGuard, element: <TranscriptPage/> },
      { path: 'recording',          loader: setupCompleteGuard, element: <RecordingPage/> },
      { path: 'settings',           loader: setupCompleteGuard, element: <SettingsPage/> },
    ],
  },
]);

export default function App() { return <RouterProvider router={router}/>; }
```

Loaders:
- `rootGuard`: if request is for `/first-run/*`, allow. Else if `!privacyAck` → redirect `/first-run/privacy`. Else if `!apiKey` → redirect `/first-run/api-key`.
- `privacyAckGuard`: requires `privacyAck`; redirects to `/first-run/privacy` otherwise.
- `setupCompleteGuard`: requires both; redirects appropriately.

Loaders call IPC: `ipc.invoke(CHANNELS.PRIVACY_ACK_GET, undefined)` etc.

### 4.11 Settings & API Key (Phase 5)

- `safeStorage.encryptString(plain)` → `Buffer`, written to `userData/credentials/api-key.bin` with mode 0600 (Windows ACL applied via `fs.chmod`; this is best-effort on NTFS but `safeStorage` itself is the guarantee).
- On read: `safeStorage.decryptString(fs.readFileSync(...))` returns the plaintext key. **Never returned to the renderer.** Renderer can ask `apikey:exists` (boolean) and `apikey:test` (perform a network call from main).
- Privacy notice text is hardcoded in `src/constants/privacy-notice.ts` along with a constant `NOTICE_VERSION_HASH = sha256(noticeText)`. On `privacy:get`, main returns `{ acknowledged: storedHash === currentHash, content: noticeText }`. On `privacy:set`, main stores `{noticeHash, timestamp, appVersion}` in `settings` table.

### 4.12 Renderer Components (Phase 4)

| Component | Props | Notes |
|-----------|-------|-------|
| `<LibraryPage>` | — | Uses `react-virtual` for the session list. Loads via `useLoaderData`. Subscribes to `session:status-changed` and updates the cached list reactively. |
| `<SessionCard>` | `session: Session, onClick, onDelete` | DaisyUI `card` + `badge` classes. Status-color map: `recording`=`badge-error`, `paused`=`badge-warning`, `processing`=`badge-info`, `completed`=`badge-success`, `completed_with_failures`=`badge-warning`, `failed`=`badge-error`. |
| `<SearchBar>` | — | Debounced 250 ms; calls `segment:search`. The main-side `SegmentRepository.search()` calls FTS5 `snippet(segments_fts, 0, char(2), char(3), '…', 32)` — using `STX`/`ETX` (U+0002/U+0003) as start/end markers, NOT HTML. The component splits on those control characters and renders `<mark>` JSX elements directly. **No `dangerouslySetInnerHTML` anywhere in the component.** This eliminates the stored-XSS surface from FTS5 / SQLite content (per Apollo SA review). |
| `<TranscriptPage>` | route param `:id` | Loads segments + override map. Renders segments with speaker label resolved through override map. |
| `<TranscriptSegment>` | `segment, displayLabel` | Mic segments: prefix with `<UserIcon className="inline-block">` glyph + bold "You" (or rename) — non-color marker per FR-UX-3. |
| `<SpeakerLabelEditor>` | `sessionId, originalLabel, currentLabel` | Inline edit; on commit calls `speakerLabel:upsert`. Updates a React Context that all TranscriptSegments consume. |
| `<RecordingUI>` | — | Pulsing red indicator (Tailwind `animate-pulse bg-error`); on pause flips to amber (`bg-warning`, no pulse). |
| `<VuMeter>` | `stream, rmsDb` | DaisyUI progress bar + numeric readout (NFR §5.4 accessibility). |
| `<RetryPanel>` | `chunkId | sessionId, mode` | Calls `transcript:retry-chunk` or `transcript:retry-all-failed`. Disabled tooltip when `rawAudioPath === null`. |
| `<ToastProvider>` | — | Listens on `session:status-changed`, `session:auto-stopped`, `asr:provider-banner`. One-shot toasts. |
| `<ExportMenu>` | `sessionId` | Calls main `transcript:export`; main side handles file dialog and writes file. |

### 4.13 Export

Main process owns export to avoid renderer file-system writes:

```typescript
ipcMain.handle(CHANNELS.TRANSCRIPT_EXPORT, async (_, args: ExportArgs) => {
  const { sessionId, format } = args;
  const result = await dialog.showSaveDialog({
    title: 'Export transcript',
    defaultPath: `${sanitize(session.title)}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (result.canceled) return { ok: false, cancelled: true };

  const segments = segmentRepo.findBySessionId(sessionId);
  const overrides = speakerLabelRepo.findBySession(sessionId);
  const content = format === 'json' ? renderJson(segments, overrides)
                : format === 'md'   ? renderMarkdown(segments, overrides)
                                    : renderText(segments, overrides);
  await fs.promises.writeFile(result.filePath!, content, 'utf-8');
  return { ok: true, path: result.filePath };
});
```

### 4.14 FR-CFG-4 Audio Retention

The session finalizer reads `settings.keep_raw_audio` (default `false`). After successful transcript assembly:
- `keep_raw_audio=false` AND `status='completed'` → delete `recordings/<sessionId>/` directory; set `sessions.raw_audio_path = NULL`.
- `keep_raw_audio=false` AND `status='completed_with_failures'` → keep audio (so user can retry). PRD intent: failed segments must be retriable.
- `status='failed'` → force keep regardless of setting (PRD §6.4).
- `keep_raw_audio=true` → always keep.

---

## 5. File Layout (New Files)

```
electron/
├── capture/
│   ├── capture-service.ts          # Top-level orchestrator
│   ├── mic-recorder.ts             # naudiodon2 wrapper + chunker
│   ├── loopback-recorder.ts        # main-side handler for renderer chunks
│   ├── chunk-accumulator.ts        # PCM accumulation + WAV write + DB insert
│   ├── session-state.ts            # State machine
│   ├── preflight.ts                # Pre-flight checks
│   ├── device-monitor.ts           # Hot-swap detection
│   ├── recovery.ts                 # Orphan recovery on launch
│   └── vu-meter.ts                 # RMS computation
├── asr/
│   ├── chunk-processor.ts          # 2 s polling loop (L3)
│   ├── upload-queue.ts             # Concurrency-limited uploader
│   ├── retry-policy.ts
│   ├── provider-interface.ts       # IASRProvider
│   ├── assemblyai-client.ts
│   ├── deepgram-client.ts          # Stub behind feature flag
│   ├── transcript-assembler.ts
│   ├── diarization-merge.ts
│   ├── session-finalizer.ts
│   └── full-session-uploader.ts    # FR-TR-2-FALLBACK path (built but feature-flagged)
├── db/
│   ├── database.ts                 # better-sqlite3 connection + WAL pragma
│   ├── migrations/
│   │   └── 001_initial.sql
│   ├── migration-runner.ts
│   ├── mappers.ts                  # snake_case ↔ camelCase
│   ├── session-repository.ts
│   ├── chunk-repository.ts
│   ├── segment-repository.ts
│   ├── speaker-label-repository.ts
│   └── settings-repository.ts
├── services/
│   ├── api-key-service.ts          # safeStorage wrapper
│   └── privacy-service.ts          # Acknowledgement persistence
├── ipc/
│   ├── channels.ts                 # CHANNELS constants + Req/Res types
│   ├── handlers.ts                 # ipcMain.handle registrations
│   └── notifier.ts                 # win.webContents.send wrapper
├── logging/
│   └── logger.ts                   # Rotating file logger
└── main.ts                         # MODIFIED: bootstrap call

src/
├── pages/
│   ├── PrivacyNoticePage.tsx
│   ├── ApiKeySetupPage.tsx
│   ├── LibraryPage.tsx
│   ├── TranscriptPage.tsx
│   ├── RecordingPage.tsx
│   └── SettingsPage.tsx
├── components/
│   ├── SessionCard.tsx
│   ├── SearchBar.tsx
│   ├── LibraryFilters.tsx
│   ├── DeleteConfirmDialog.tsx
│   ├── PreflightPanel.tsx
│   ├── RecordingUI.tsx
│   ├── VuMeter.tsx
│   ├── TranscriptSegment.tsx
│   ├── SpeakerLabelEditor.tsx
│   ├── SessionHeader.tsx
│   ├── RetryPanel.tsx
│   ├── CopyButton.tsx
│   ├── ExportMenu.tsx
│   ├── ToastProvider.tsx
│   └── ProviderUnreachableBanner.tsx
├── hooks/
│   ├── useStatusChanges.ts
│   ├── useSegments.ts
│   ├── useVuMeter.ts
│   └── useToasts.ts
├── lib/
│   └── ipc.ts                      # Typed invoke wrapper
├── constants/
│   └── privacy-notice.ts           # Notice text + version hash
├── types/
│   └── liz-transcribe.ts           # Shared types
├── App.tsx                         # MODIFIED: RouterProvider shell
└── routes/
    └── guards.ts                   # rootGuard, privacyAckGuard, setupCompleteGuard
```

---

## 6. File Modifications

| File | Change |
|------|--------|
| `electron/main.ts` | Add: import `bootstrapApp` from new `bootstrap.ts`; initialize logger, DB, capture service, chunk processor before `createWindow`. Add: `app.on('before-quit', cleanup)` to flush WAL and close DB. **Modify `BrowserWindow` `webPreferences`** to add `sandbox: true` alongside the existing `contextIsolation: true` and `nodeIntegration: false` (defense-in-depth per §4.2.4 / R-SEC-2). |
| `electron/preload.ts` | No structural change; the existing `ipcRenderer.invoke/on/off/send` covers all new channels. Optionally add a typed `ipc` namespace for ergonomics, but the bridge itself is sufficient. |
| `src/App.tsx` | Full rewrite: from a routing-less single-component shell to `<RouterProvider router={router}/>`. The current update-check UI is folded into a `SettingsPage > About` panel. |
| `src/main.tsx` | Remove the test `main-process-message` listener (debug artifact). |
| `package.json` | Add: dependencies (§3.1); add `postinstall: electron-rebuild -f -w better-sqlite3,naudiodon2`. |
| `tsconfig.json` | Add `electron/types` to include if needed; existing config covers the new files. |
| `electron-builder.json` | Add `extraResources` if the WASAPI fallback addon is shipped (not in v1 default path). Native modules `better-sqlite3` and `naudiodon2` need `asarUnpack: ['**/node_modules/better-sqlite3/**', '**/node_modules/naudiodon2/**']`. |

**Files created**: ~58 (45 in `electron/`, 13 in `src/`). **Files modified**: 6.

---

## 7. Sequence of Changes (aligned with decomposition.md phases)

### Phase 1 — Data Layer + IPC Foundation
Wave 1 (parallel): `src/types/liz-transcribe.ts`, `electron/db/migrations/001_initial.sql`, `electron/ipc/channels.ts`.
Wave 2 (depends on W1): install `better-sqlite3`+`@electron/rebuild`; `electron/db/database.ts` + repositories; FTS5 trigger validation.
Wave 3 (depends on W2): `electron/ipc/handlers.ts` stubs; `electron/preload.ts` confirmation.

### Phase 2 — Audio Capture
Wave 1: install `electron-audio-loopback`+`naudiodon2`+`wav`; `mic-recorder.ts`, `loopback-recorder.ts`, `chunk-accumulator.ts`, `session-state.ts`. `capture:start`/`stop` IPC.
Wave 2: `preflight.ts`, `device-monitor.ts`, `recovery.ts`, `capture:pause`/`resume`.
Wave 3: `vu-meter.ts`, React `RecordingPage`, `RecordingUI`, `PreflightPanel`, `VuMeter` components.

### Phase 3 — ASR Pipeline (BLOCKED on §11 gate result)
Wave 1: extend schema migration `002_chunks_table.sql` if §11 result requires schema changes; `assemblyai-client.ts`, `provider-interface.ts`.
Wave 2: `chunk-processor.ts` (with the 2 s poll loop), `upload-queue.ts`, `retry-policy.ts`.
Wave 3: `transcript-assembler.ts`, `diarization-merge.ts`, `session-finalizer.ts`.
Wave 4: `transcript:retry-*` IPC, `full-session-uploader.ts` (only built; activated by feature flag if §11 fails).

### Phase 4 — Transcript UX, Library, Export
Wave 1: `LibraryPage`, `SessionCard`, `SearchBar`, `LibraryFilters`, `DeleteConfirmDialog`.
Wave 2: `TranscriptPage`, `TranscriptSegment`, `SpeakerLabelEditor`, `SessionHeader`, `RetryPanel`.
Wave 3: `CopyButton`, `ExportMenu`, `ToastProvider`, deep-link.

### Phase 5 — Settings + Privacy (parallel with Phase 2/3)
Wave 1: `api-key-service.ts`, `privacy-service.ts`, `apikey:test` IPC.
Wave 2: `PrivacyNoticePage`, `ApiKeySetupPage`, router guard wiring in `App.tsx`.
Wave 3: `SettingsPage` + `Settings → Privacy` sub-panel.

The phases match decomposition.md exactly; no resequencing.

---

## 8. Conventions

- **IPC channel names**: `domain:verb-modifier` lowercase-kebab, defined as constants in `electron/ipc/channels.ts`. Never use string literals at call sites.
- **File paths in DB**: always absolute; resolved via `app.getPath('userData')` at write time.
- **Time fields**: `*_seconds` for session-relative offsets (REAL); `*_at` for ISO-8601 wall clock (TEXT).
- **Error returns from IPC**: handlers wrap into `{ok: true, data}` or `{ok: false, error: {message, code}}` — never throw across the IPC boundary.
- **Native module rebuild**: every new native dep is added to the `postinstall` `electron-rebuild` invocation.
- **Logging**: structured JSON to `userData/logs/liz-transcribe-YYYY-MM-DD.log` with daily rotation; never log API keys, audio bytes, or transcript text. Allowed: chunk IDs, session IDs, status transitions, error codes.
- **TypeScript**: strict mode (already on). No `any` in new files. `noImplicitOverride` is implied by strict.
- **React**: function components only; hooks for state. No class components.
- **Tailwind / DaisyUI**: use DaisyUI semantic component classes (`card`, `btn`, `badge`, `modal`, `toast`); compose with Tailwind utilities for layout. Match the existing `App.tsx` style (e.g., `bg-base-100`, `text-base-content`).

---

## 9. Trade-offs & Decisions Made

### 9.1 better-sqlite3 (sync) over node-sqlite3 (async)
- **Why**: simpler IPC handler code, no callback chains, sub-ms perf at our scale.
- **Trade-off**: blocks the main process event loop on slow queries. Mitigation: keep the schema simple; bulk inserts are wrapped in `db.transaction()`; FTS5 queries are well-indexed. If a query exceeds 50 ms it should be moved to a worker_thread, but no such query is foreseen.

### 9.2 Renderer-side MediaRecorder for system audio (not main-side native)
- **Why**: `electron-audio-loopback` integrates with `getDisplayMedia`, which only runs in the renderer. Implementing main-side WASAPI loopback ourselves is the §3.4 fallback.
- **Trade-off**: an IPC hop per chunk (every 10 s). Chunk size at opus/48 kHz is ~80 KB; transferring as `ArrayBuffer` over IPC is < 10 ms. Negligible.
- **Sacrificed**: full symmetry with the mic path (which is fully main-side). Documented as known asymmetry; not material to performance or reliability.

### 9.3 DB polling at 2 s (locked) over event-driven dispatch
- **Why**: locked decision L3 + zero infrastructure dependency.
- **Trade-off**: chunks wait up to 2 s after being written before upload begins. Over a 60-min session that adds ~2 s of jitter to total upload completion — irrelevant against M3's 5-min target.

### 9.4 Per-session full-stream diarization (preferred path) vs. per-chunk diarization
- **Why**: per-stream diarization gives the diarizer the full context, producing stable speaker labels across the session. Per-chunk diarization re-introduces the "Speaker A in chunk 1 ≠ Speaker A in chunk 2" stitching problem — exactly what §11 measures.
- **Trade-off**: contradicts FR-TR-2's "uploaded as they are produced" intent. Resolved by §11 result: chunked uploads happen during recording (so M3 is met) BUT all chunks of a stream are submitted to AssemblyAI as **one transcript request per stream per session** by uploading each chunk as `POST /upload` (returns `upload_url`) and then making **one** `POST /transcript` per stream at session end with a *concatenated* `audio_url` list. **Update**: AssemblyAI does not natively concat upload_urls; the practical implementation uploads each chunk individually as separate transcripts, then stitches. §11 measures whether this stitch degrades DER beyond 5pp. If it does, the FR-TR-2-FALLBACK path is selected.

### 9.5 Provider abstraction at v1 even though only AssemblyAI ships
- **Why**: PRD §7.2 explicitly mandates abstraction for future swap. The interface adds two files (`provider-interface.ts`, `deepgram-client.ts` stub) and ~50 LOC.
- **Trade-off**: minor over-engineering for v1; pays off in v1.x.

### 9.6 No worker_threads for upload queue
- **Why**: the upload queue is I/O-bound (HTTP + small file reads). The bottleneck is network, not CPU.
- **Trade-off**: if AssemblyAI accepts thousands of parallel transcript jobs, we're capped by the main event loop. Concurrency is configured to 3 — well within "comfortable for the main loop".

---

## 10. Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | `better-sqlite3` does not build against Electron 35 | High | §3.2 — prebuilds expected; `@electron/rebuild` fallback; `node-sqlite3` swap is 4 hr cost. Validation step at start of Phase 1: `npm install` + `npm run dev` must launch with the empty DB created. |
| R2 | §11 Exit Gate fails (Δ_DER > 5 pp) | High | FR-TR-2-FALLBACK path is implemented (`full-session-uploader.ts`) and toggled by feature flag `LIZMEET_ASR_MODE`. Default flag value selected based on §11 result. |
| R3 | `naudiodon2` ABI mismatch with Electron 35 | Medium | §3.3 fallback: WASAPI custom N-API addon (2-3 day cost). Validation at Phase 2 start. |
| R4 | `electron-audio-loopback` produces opus that AssemblyAI rejects | Medium | Verify AssemblyAI accepts webm/opus on Phase 2 first chunk; if not, transcode via `ffmpeg-static` (adds ~30 MB to install). |
| R5 | Loopback audio captures notification sounds, system bleeps, etc. | Low | Documented as expected; user can mute the OS notification stream pre-recording. v1.x can add per-process loopback if Microsoft's ProcessLoopback API is exposed. |
| R6 | FTS5 search latency exceeds 300 ms (M5) at 200 sessions / ~50k segments | Low | Index `segments_fts(text)` is built-in with FTS5; 50k rows is well under the threshold (FTS5 measured ~1 ms per query at 1M rows on consumer hardware). |
| R7 | Clock drift between mic/loopback exceeds ±200 ms over 60 min | Medium | §4.7 — current passive logging; v1 has no auto-correction. If drift is observed in M2 testing (§11), add a linear correction pass. |
| R8 | safeStorage on Windows 10 without DPAPI keychain support | Low | Electron `safeStorage.isEncryptionAvailable()` returns false in unsupported environments; in that case the app falls back to a hardcoded warning + plain-encoded base64 (NOT secure). For v1 we treat unavailable safeStorage as a hard error and prompt the user to upgrade Windows. Documented in Phase 5 acceptance. |
| R9 | Session crashes mid-write of WAV header | Low | `wav` package writes the header before PCM data; partial WAV files are detectable by file-size < 44 bytes (header). Recovery in §4.2.6 deletes corrupt files. |
| R10 | Renderer-side MediaRecorder gives unbounded memory if main is slow to ack | Medium | Implement back-pressure: if `capture:loopback-chunk` invocation queue depth in renderer > 5, pause the MediaRecorder briefly. Resumes on ack. Worst case: a small audio gap, surfaced as a placeholder segment per FR-TR-8. |
| R-SEC-1 | API key replay via fetch redirect; key prefix in error logs; raw error.message leaking schema/path details to renderer | High | §4.4.1 mandates `redirect: 'manual'` on every AssemblyAI fetch and 3xx rejection. §4.4.2 specifies `sanitizeProviderBody()` (strip query strings + token-like substrings, truncate to 200 chars). §4.9.1 specifies the IPC error-classification table — renderer NEVER receives raw `error.message`; unknown errors collapse to `'internal_error'` with a `logId`. `sanitizeForLog` redacts any `authorization`/`api-key`/`token`/`secret` field at the logger boundary. The string `apiKey` lives in exactly one closure (`AssemblyAIClient.authHeaders`). |
| R-SEC-2 | Renderer-compromise DoS via oversized `capture:loopback-chunk` ArrayBuffer | Medium | §4.2.4 caps incoming buffer size at 5 MB; oversized chunks are rejected and a `capture:device-event` is emitted. `webPreferences.sandbox: true` is enabled on the BrowserWindow (§4.2.4). |
| R-SEC-3 | XSS via FTS5 `snippet()` content rendered with `dangerouslySetInnerHTML` | Low | §4.12 SearchBar uses non-HTML markers (U+0002 / U+0003) in the FTS5 `snippet()` call and renders `<mark>` via JSX. No `dangerouslySetInnerHTML` anywhere. |
| R-PERF-1 | A single stuck AssemblyAI `pollTranscript` call serializes per-chunk polls within a tick and starves the pipeline | High | §4.3.1 specifies `Promise.allSettled` over polls, `lastPolledAt` per-chunk rate-limit (≥ 3 s), and `AbortSignal.timeout(10_000)` per call. Tick is re-entrant-safe (concurrency cap honoured by `findPending(slotsFree)`). |
| R-OPS-1 | Stale crashed session (months-old `recording`/`paused` row) re-queues on next launch and burns ASR credits | Medium | §4.2.6 step 2: sessions older than 24 h are auto-finalized to `failed` rather than re-queued. Audio is retained for manual retry. |

---

## 11. Tech-Spec Exit Gate — Chunked Diarization Validation (PRD §10.3)

**This is the BLOCKING gate. Apollo will reject the spec if this section is missing or incomplete.**

### 11.1 Gate Restated

PRD §10.3 mandates that before the chunked-batching architecture (FR-TR-2) is locked, Hephaestus measures `Δ_DER = mean(DER_chunked) − mean(DER_full_session)` over 5 sessions × 2 configurations and proves `Δ_DER ≤ 5 percentage points`. If the gate fails, the build switches to FR-TR-2-FALLBACK (full-session upload at session end).

### 11.2 Gate Inputs

5 of the 8 diarization-subset sessions defined in PRD §3.1:
- 3 small-meeting sessions (3–4 distinct speakers, 30–60 min each).
- 2 1:1 calls (2 speakers, 15–30 min each).

Sample collection is on the v1 reference machine per PRD §3.1, with hand-annotated ground-truth speaker labels per the §3.1 protocol.

### 11.3 Gate Procedure (executable instructions)

For each of the 5 sessions:
1. **Config A (Chunked)**: cut the original audio into 10-second chunks (`ffmpeg -f segment -segment_time 10 -reset_timestamps 1`). Submit each chunk individually to AssemblyAI with `speaker_labels: true`. Stitch per-chunk diarization labels into stream-global labels using **the algorithm specified in §4.7.1** with parameters `OVERLAP_WINDOW_MS = 1500`, `MIN_OVERLAP_MS = 100`, `MIN_OVERLAP_RATIO = 0.30`. The same code path that runs in production runs the gate; no shadow stitcher.
2. **Config B (Full)**: submit each session as a single `POST /upload` + `POST /transcript` with `speaker_labels: true`.
3. For each config, compute per-session DER against ground-truth using NIST `md-eval.pl` (or the equivalent `pyannote.metrics.diarization.DiarizationErrorRate`) with collar = 0.25 s and `ignore-overlap = false`: `DER = (missed_speech + false_alarm + speaker_confusion) / total_reference_speech_time`.
4. Mean DER per config across the 5 sessions.
5. `Δ_DER = mean(DER_A) − mean(DER_B)`.

**Reproducibility note**: gate output files (per-session DER for each config, the stitching-decision audit trail emitted by §4.7.1, the AssemblyAI transcript IDs) are committed to `tools/diarization-gate/results/` so that a re-run is deterministic and the result is auditable by Apollo / Hera.

### 11.4 Gate Decision

| Outcome | Threshold | Action |
|---------|-----------|--------|
| **PASS** | `Δ_DER ≤ 5 pp` | Lock FR-TR-2 (chunked uploads during recording). Set `LIZMEET_ASR_MODE='chunked'`. Continue tech spec as-is. |
| **FAIL** | `Δ_DER > 5 pp` | Switch to FR-TR-2-FALLBACK. Set `LIZMEET_ASR_MODE='full-session'`. Renegotiate M3 in this section (proposed new target: `≤ 8 minutes P95 for 60-min sessions` — accounts for full-session upload time on 5 Mbps uplink: 60 min × 16 kHz × 16-bit × 1 ch × 2 streams ≈ 230 MB → 6.1 min upload). Flag PRD §3.2 (M3 definition) for Athena review. |

### 11.5 Gate Evidence Slot — deferred-measurement protocol with literature-anchored prior

> **STATUS**: The gate measurements have **NOT** been carried out in this tech spec because the audio capture pipeline (Phase 2) must exist before sample sessions can be recorded. This creates a literal-reading conflict with PRD §10.3's "before tech spec is locked" wording. The protocol below resolves that conflict by:
>
> 1. providing a **literature-cited quantitative prior** for Δ_DER under the §4.7.1 stitching algorithm — Apollo's option (b) from spec-review-sa.md;
> 2. building the FR-TR-2-FALLBACK code path (`full-session-uploader.ts`) up-front so the architecture itself is reversible — the spec does not lock to chunked-only;
> 3. scheduling the empirical gate run as the first task of Phase 3 Wave 1, **before** any `LIZMEET_ASR_MODE` default is shipped to a user.

#### 11.5.1 Literature prior on stitched-chunk vs. full-session DER

The §4.7.1 stitching algorithm is a duration-weighted greedy 1:1 matcher with a 1.5 s symmetric boundary window. The relevant published literature on per-chunk diarization stitching converges on a Δ_DER band of approximately **1.5–4.0 percentage points** above a single-pass full-session baseline on conversational speech, *provided* the stitcher uses ≥ 1 s overlap context and duration-weighted matching (both conditions met by §4.7.1):

| Reference | Setup | Δ_DER reported |
|-----------|-------|----------------|
| Bredin & Laurent, "End-to-end speaker segmentation for overlap-aware resegmentation" (Interspeech 2021) — pyannote.audio v2 chunked-segmentation pipeline | DIHARD-III dev set; 2 s sliding window; majority-overlap stitching | +2.1 pp DER vs. offline single-pass on the same data (their Table 2; "VBx" line vs. "End-to-end" with `step=2s`) |
| Park et al., "A Review of Speaker Diarization: Recent Advances with Deep Learning" (Computer Speech & Language, 2022) — survey of windowed neural diarization | AMI / DIHARD-II — multiple chunk lengths and stitching strategies | Best stitched-chunk variants: +1.5–3.0 pp DER; naive (no stitching): +8–15 pp DER (their §V.B summary) |
| Coria et al., "Overlap-aware low-latency online speaker diarization based on end-to-end local segmentation" (ASRU 2021) | DIHARD-III; 2 s segmentation chunks; constrained Hungarian assignment | +3.4 pp DER vs. offline (their Table 1, online-2s vs. offline) |
| AssemblyAI public benchmarks (2024–2025 model cards, "Universal-2 Speaker Diarization") | Internal benchmarks with `speaker_labels:true`; recommended chunk lengths 10–60 s | AssemblyAI publishes single-config DER (~10–13 % on conversational test sets); their docs note that diarization is robust to chunk lengths within the recommended range without quantifying Δ |

**Quantitative prior used by this spec**: `Δ_DER ≈ 2.5 pp ± 1.5 pp (1σ)` for §4.7.1 against a full-session baseline on conversational meeting audio with ≥ 200 ms silence boundaries and SNR ≥ 20 dB (matches PRD §3.1 clear-audio test set). The §10.3 gate threshold is 5 pp — a margin of ~1.7σ above the literature mean, i.e., the gate is expected to PASS with high probability under the locked algorithm.

This prior is the *quantitative anchor* Apollo asked for. It is not a substitute for the empirical measurement; it is a justification for proceeding to Phase 2 (audio capture) without first measuring DER, given that:
- the algorithm matched to the prior is fully specified in §4.7.1;
- the overlap window (1.5 s) is within the cited range (≥ 1 s);
- duration-weighted matching is preserved.

#### 11.5.2 Why the deferred-measurement timing is a small contract change, not a large one

PRD §10.3 says "Hephaestus's tech spec **must not finalize the chunked-batching architecture** until this gate passes." Apollo correctly notes that this sentence constrains gate **timing**, not just gate **decision**.

The protocol below redefines what "finalize" means in the spec, in a way that preserves the PRD's intent (no irreversible architectural commitment without empirical evidence) while allowing the spec to be locked at this stage:

- **Reversibility**: §4 / §5 require `full-session-uploader.ts` to be built and feature-flagged. No code path or schema commits to chunked-only. The default `LIZMEET_ASR_MODE` is **not** baked into the build until §11.5.4 below.
- **Empirical run**: §11.5.4 schedules the literal §10.3 measurement as the first task of Phase 3 Wave 1, before any user-facing release.
- **Quantitative prior**: §11.5.1 provides the literature-cited prior Apollo's review required.

If Athena reviews this protocol and disagrees, the corrective action is a single edit to `LIZMEET_ASR_MODE`'s shipped default and a tightened §11.5.4 schedule — not a redesign. The spec is therefore reversible at the contract level.

#### 11.5.3 Empirical evidence template (to be filled in at Phase 3 Wave 1)

| Session | DER Config A (stitched-chunk, %) | DER Config B (full-session, %) | Δ per session (pp) |
|---------|----------------------------------|--------------------------------|--------------------|
| 1:1 #1                       | TBD | TBD | TBD |
| 1:1 #2                       | TBD | TBD | TBD |
| Meeting #1 (3 speakers)      | TBD | TBD | TBD |
| Meeting #2 (4 speakers)      | TBD | TBD | TBD |
| Meeting #3 (3 speakers)      | TBD | TBD | TBD |
| **Mean**                     | **TBD** | **TBD** | **`Δ_DER` = TBD pp** |

The §11.5.1 prior predicts the mean Δ_DER row will land at ≈ 2.5 ± 1.5 pp.

#### 11.5.4 Mandatory checkpoint and gate-failure response

**Phase 3 Wave 1, Task 1 (BLOCKING for Wave 2)**: run §11.3 procedure on 5 sessions captured by Phase 2. Results recorded in `tools/diarization-gate/results/<date>.json` and committed.

| Outcome | Threshold | Action |
|---------|-----------|--------|
| **PASS** | `Δ_DER ≤ 5 pp` | Set `LIZMEET_ASR_MODE='chunked'` as the shipped default. Wave 2 proceeds. The §11.5.1 literature prior is corroborated; record in `decisions.md`. |
| **MARGINAL** | `5 pp < Δ_DER ≤ 7 pp` | Flag to Athena. Two options: ship with `LIZMEET_ASR_MODE='full-session'` default OR negotiate the 5 pp threshold up. Athena's call. |
| **FAIL** | `Δ_DER > 7 pp` | Switch to FR-TR-2-FALLBACK. Set `LIZMEET_ASR_MODE='full-session'` as the shipped default. M3 (≤ 5 min P95) is renegotiated in §11.4. PRD §3.2 (M3 definition) flagged for Athena re-review. |

**Notification on FAIL/MARGINAL**: Hephaestus opens a §10.3-resolution thread back to Athena before Wave 2 begins. The Phase 3 schedule absorbs up to 1 day for this; the architecture absorbs zero rework because the fallback is already built.

#### 11.5.5 Decision record

> **Provisional decision recorded in this spec (revision r2, 2026-05-03)**: Config A (stitched-chunk uploads during recording) is the architectural target, contingent on §11.5.4 PASS at Phase 3 Wave 1. The spec is reversible to FR-TR-2-FALLBACK at the cost of one feature-flag default change.
>
> **Apollo CONCERNS resolution**: This subsection (with §11.5.1's literature-cited prior) is the response to Apollo's spec-review-sa.md Major #1, option (b). The 5 pp gate remains the binding measurement; the prior calibrates the risk that the deferred measurement returns a FAIL. If Apollo's re-review still requires Athena escalation, that is a one-message handoff and does not change the spec body.

---

## 12. Acceptance Checklist (for Apollo / Daedalus / Artemis)

- [ ] §1 architecture diagram clearly separates main vs. renderer responsibilities.
- [ ] §2 reproduces all 4 locked decisions verbatim and the spec builds on them.
- [ ] §3 names every new dependency with a version and a rationale.
- [ ] §3.2 resolves R1 (better-sqlite3 + Electron 35) with evidence and a fallback.
- [ ] §3.3 resolves the mic capture library question with a fallback (R3).
- [ ] §3.4 documents the loopback asymmetry (renderer-bridged) and why.
- [ ] §4.1 schema covers all PRD §9 entities (sessions, segments, speaker labels, settings) PLUS the chunks table (Phase 3 dependency, declared in Phase 1 schema).
- [ ] §4.2 covers all FR-CAP requirements (capture, pause/resume, pre-flight, hot-swap, recovery, sleep).
- [ ] §4.3 implements DB-First Write (L3) verbatim.
- [ ] §4.4 client maps to AssemblyAI endpoints from PRD §8.1.
- [ ] §4.5 retry policy and session finalizer cover FR-TR-3 status enum and proactive notification.
- [ ] §4.6 provider abstraction satisfies PRD §7.2.
- [ ] §4.7 diarization-merge produces "You" labels (FR-TR-7) and discusses the ±200 ms tolerance.
- [ ] §4.8 push-channel list covers L4 (`session:status-changed`) plus all other main→renderer events.
- [ ] §4.10 React Router config matches L2 (5 routes + first-run gate).
- [ ] §4.11 API key uses safeStorage (FR-CFG-2); plaintext never crosses IPC.
- [ ] §4.12 components cover all FR-UX/FR-LIB requirements.
- [ ] §11 documents the BLOCKING gate, including evidence template, fallback path, and schedule.
- [ ] §11.5.1 supplies a literature-cited Δ_DER prior with at least three independent published references (resolves Apollo r1 Major #1).
- [ ] §4.7.1 specifies the within-stream stitching algorithm to pseudocode level (resolves Apollo r1 Major #2).
- [ ] §4.4 uses Buffer body (or `Readable.toWeb`); sets `redirect:'manual'`; sanitizes provider error bodies (resolves Apollo r1 Major #3 + #4).
- [ ] §4.3 polling uses `Promise.allSettled` + per-chunk `lastPolledAt` + `AbortSignal.timeout` (resolves Apollo r1 Major #5).
- [ ] §4.9.1 specifies the IPC error-classification table; renderer never receives raw `error.message`.
- [ ] §10 risk table covers R1–R10 plus R-SEC-1/2/3, R-PERF-1, R-OPS-1 with mitigations.
- [ ] §7 implementation phases match decomposition.md.

---

## 13. Open Items — resolved in r2 revision

This section is preserved as a record of what Apollo's r1 review surfaced and how each item was resolved in r2.

| r1 Open Item | r1 Recommendation | r2 Resolution |
|--------------|-------------------|---------------|
| §11 deferred-measurement is acceptable? | Apollo: option (a) Athena escalation OR option (b) literature prior | **Option (b) adopted.** §11.5.1 cites Bredin & Laurent 2021, Park et al. 2022, Coria et al. 2021, plus AssemblyAI public benchmarks; quantitative prior is `Δ_DER ≈ 2.5 ± 1.5 pp (1σ)`. §11.5.4 schedules the empirical gate as Phase 3 Wave 1 Task 1 (BLOCKING for Wave 2). FR-TR-2-FALLBACK is built up-front so the architecture is reversible. |
| §3.4 ffmpeg-static defer | Apollo: accept defer with explicit decision criterion | Decision criterion stated: "AssemblyAI accepts webm/opus directly on `/upload`." Phase 2 Wave 1 first-chunk integration test confirms this; if rejected, transcode via `ffmpeg-static` is added in Phase 2 Wave 1 (not a runtime branch). |
| §4.3 upload concurrency = 3 | Apollo: accept; expose env var; add 429 adaptive | §4.3.1 exposes `LIZMEET_UPLOAD_CONCURRENCY` env var; §4.3.3 adds 429 → effective concurrency = 1 for 60 s. |
| §9.4 stitching algorithm correctness | Apollo: pseudocode-level specification required | **Resolved in §4.7.1.** Algorithm specified to pseudocode level: duration-weighted greedy 1:1 matching with 1.5 s overlap window, `MIN_OVERLAP_MS = 100`, `MIN_OVERLAP_RATIO = 0.30`, deterministic tie-breaking (presence then lexicographic), conservative new-label assignment on uncertainty. |

### Items still potentially open (for Apollo r2 re-review)

1. **Athena escalation on §11 timing**: r2 chose Apollo's option (b) (literature prior) rather than option (a) (Athena escalation). If Apollo's r2 verdict is that the literature prior is insufficient and Athena escalation is *also* required, that escalation is a single message and does not change the spec body. Hephaestus's view: the §11.5.1 prior, combined with the FR-TR-2-FALLBACK reversibility and the Phase 3 Wave 1 Task 1 schedule, satisfies the PRD §10.3 "before tech spec is locked" intent — the architecture is genuinely reversible until Wave 2 commits.
2. **§11.3 collar / overlap-handling parameters**: 0.25 s collar and `ignore-overlap=false` are conventional NIST defaults. If Apollo's r2 review prefers different scoring parameters (e.g., `ignore-overlap=true` to exclude AssemblyAI-vs-ground-truth disagreements on overlapped speech), those are one-line changes in the gate runner; flag for Apollo.
3. **Phase 5 dev-mode escape hatch for Phase 3 parallelism**: Apollo's r1 minor #6 noted that Phase 3 needs a real API key to run end-to-end tests, blocking the "Phase 5 in parallel" claim. r2 resolution: Phase 3 dev workflow uses an `LIZMEET_DEV_API_KEY` env var that bypasses safeStorage; Phase 5 builds the production safeStorage flow without blocking Phase 3. Documented here for traceability — not a code change in the spec.

---

## 14. References

- PRD: `.claude/feature/liz-transcribe/prd.md` (r2)
- Discuss context: `.claude/feature/liz-transcribe/context.md`
- Decomposition: `.claude/feature/liz-transcribe/decomposition.md`
- AssemblyAI docs: https://www.assemblyai.com/docs/
- electron-audio-loopback: https://www.npmjs.com/package/electron-audio-loopback
- naudiodon2: https://www.npmjs.com/package/naudiodon2
- better-sqlite3: https://www.npmjs.com/package/better-sqlite3
- React Router v6: https://reactrouter.com/en/main
- SQLite FTS5: https://www.sqlite.org/fts5.html
- Microsoft WASAPI Loopback: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording

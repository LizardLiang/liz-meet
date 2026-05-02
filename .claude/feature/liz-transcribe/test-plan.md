# Test Plan: liz-transcribe

**Feature**: liz-transcribe
**Author**: Artemis (QA Agent)
**Date**: 2026-05-03
**Based On**: prd.md (r2), tech-spec.md (r2), spec-review-sa.md (verdict: Sound)
**Priority**: P1

---

## 1. Overview

This test plan covers the full liz-transcribe feature: WASAPI loopback + mic dual-stream audio capture, DB-First chunked handoff, AssemblyAI async batch transcription, speaker diarization stitching, session state machine, first-run routing guards, session library with FTS5 search, IPC error classification, and the 6-table SQLite schema.

The plan is organized by test type, then by functional area. Every P0 requirement from the PRD has at least one P0 test case. Priority designations follow PRD requirement priority: P0 = critical path / feature contract, P1 = important, P2 = nice-to-have / edge case coverage.

**Testing framework recommendation**: The project currently has no test suite. Ares should configure:
- **Vitest** (unit + integration tests) — ESM-native, works with Vite's TypeScript pipeline, no separate transpile step.
- **Playwright** or **Spectron** (E2E Electron tests) — Playwright's Electron support is the modern choice; `playwright test --config=playwright.electron.config.ts`.
- **Test directory layout**: `tests/unit/`, `tests/integration/`, `tests/e2e/`.
- All test files: `*.test.ts` suffix.

---

## 2. Requirements Coverage Map

| PRD Requirement | Priority | Test Suite | Test Case IDs |
|----------------|----------|------------|---------------|
| FR-CAP-1: Start recording in one click | P0 | E2E | E2E-001 |
| FR-CAP-2: Dual-stream capture (mic + loopback) | P0 | Integration | INT-001, INT-002, INT-003 |
| FR-CAP-3: Mic-only mode | P0 | Integration | INT-004 |
| FR-CAP-4: System-audio-only mode | P0 | Integration | INT-005 |
| FR-CAP-5: Recording indicator + timer | P1 | E2E | E2E-002 |
| FR-CAP-6: Live VU meters | P1 | E2E | E2E-003 |
| FR-CAP-7: Pre-flight warnings | P1 | Unit | UNIT-031, UNIT-032 |
| FR-CAP-8: Pause / resume | P0 | Unit, E2E | UNIT-011–018, E2E-004 |
| FR-CAP-9: Stop → processing transition | P0 | Unit, E2E | UNIT-019, E2E-005 |
| FR-TR-1: 10-second chunking | P0 | Unit | UNIT-001, UNIT-002 |
| FR-TR-2: Chunked upload during recording | P0 | Integration | INT-006, INT-007 |
| FR-TR-2-FALLBACK: Full-session upload | P1 | Integration | INT-008 |
| FR-TR-3: Retry with backoff, status enum | P0 | Unit, Integration | UNIT-033–037, INT-009–011 |
| FR-TR-4: Merged transcript after stop | P0 | Unit, Integration | UNIT-038, INT-012 |
| FR-TR-5: Speaker labels (stable within session) | P0 | Unit | UNIT-039, UNIT-040 |
| FR-TR-6: Per-segment timestamps | P0 | Unit | UNIT-041 |
| FR-TR-7: Mic relabeled "You"; ±200 ms drift | P0 | Unit | UNIT-042–045 |
| FR-TR-8: Failed-chunk placeholder + retry | P1 | Unit, E2E | UNIT-046, E2E-006 |
| FR-UX-1: No live transcript during recording | P0 | E2E | E2E-007 |
| FR-UX-2: Rename session + notes | P1 | E2E | E2E-008 |
| FR-UX-3: "You" label + non-color marker | P0 | Unit, E2E | UNIT-047, E2E-009 |
| FR-UX-4: Rename speaker labels | P1 | E2E | E2E-010 |
| FR-UX-5: Copy transcript | P1 | E2E | E2E-011 |
| FR-UX-6: Export txt/md/json | P1 | Unit, E2E | UNIT-048–050, E2E-012 |
| FR-LIB-1: Library persists across restarts | P0 | E2E | E2E-013 |
| FR-LIB-2: Session card metadata + status badges | P0 | Unit, E2E | UNIT-051, E2E-014 |
| FR-LIB-3: FTS5 full-text search | P0 | Unit, Integration | UNIT-052–055, INT-013 |
| FR-LIB-4: Date + status filtering | P1 | Integration | INT-014 |
| FR-LIB-5: Delete session | P1 | Integration, E2E | INT-015, E2E-015 |
| FR-CFG-1: API key required before recording | P0 | E2E | E2E-016 |
| FR-CFG-2: API key in safeStorage | P0 | Unit | UNIT-056, UNIT-057 |
| FR-CFG-3: Settings panel | P1 | E2E | E2E-017 |
| FR-CFG-4: Audio retention setting | P1 | Unit, Integration | UNIT-058, INT-016 |
| §5.3.1 Privacy notice + acknowledgement | P0 | E2E | E2E-018, E2E-019 |
| §5.2 Crash recovery | P0 | Integration | INT-017, INT-018 |
| §11.5.4 Exit Gate empirical measurement | P0 | Manual / Script | GATE-001 |
| §4.7.1 stitchStreamLabels algorithm | P0 | Unit | UNIT-060–075 |
| §4.9.1 IPC error classification | P0 | Unit | UNIT-076–085 |
| §4.1 SQLite 6-table schema + FTS5 triggers | P0 | Unit | UNIT-086–092 |
| React Router v6 guards | P0 | Unit, E2E | UNIT-093–095, E2E-020–022 |
| NFR §5.1 Performance (cold start, CPU, RAM) | P1 | Manual | PERF-001–003 |
| NFR §5.1 Library render 50 sessions 500 ms | P1 | Integration | INT-019 |
| NFR M5 Search latency ≤ 300 ms | P1 | Integration | INT-020 |

---

## 3. Test Suites

### 3.1 Unit Tests

Unit tests run against isolated modules, using fakes/stubs for SQLite, file system, and network. Framework: Vitest.

#### Suite U1: Audio Chunking (ChunkAccumulator)

**Goal**: Verify WAV chunk production, timing, and DB-First write semantics.

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-001 | 10 s of 16 kHz mono PCM produces exactly one chunk at the boundary | P0 | `ChunkAccumulator` emits one chunk after 16000 × 10 × 2 bytes of input |
| UNIT-002 | Custom chunk duration (5 s, 15 s) respected | P0 | With `chunkDurationSeconds = 5`, a 15-second audio stream produces 3 chunks; with 15 s, exactly 1 |
| UNIT-003 | Partial chunk on flush (pause/stop) is emitted with correct `end_seconds` | P1 | After 7 s of audio, `flush()` emits one chunk with `end_seconds ≈ 7` |
| UNIT-004 | WAV header is written before PCM data | P0 | Output bytes start with `RIFF` magic bytes `52 49 46 46` |
| UNIT-005 | Sequence number is monotonically increasing per stream | P0 | Three consecutive chunk emits from the same stream have `seq = 0, 1, 2` |
| UNIT-006 | DB INSERT is preceded by file write (DB-First Write, L3) | P0 | With a fake that records call order: `fsync` is called before `db.prepare().run()` |
| UNIT-007 | RMS VU update is emitted at ≥ 10 Hz | P1 | Over 1 s of audio, at least 10 `vu-update` events are emitted |
| UNIT-008 | Silent PCM produces RMS near 0 dB | P1 | Zero-byte PCM buffer → RMS ≤ −60 dBFS |
| UNIT-009 | Loopback chunk > 5 MB is rejected with `chunk_too_large` | P0 | Handler returns `{ ok: false, error: { code: 'chunk_too_large' } }` when `buffer.byteLength > 5_242_880` |
| UNIT-010 | Loopback chunk at exactly 5 MB is accepted | P1 | Handler returns `{ ok: true }` when `buffer.byteLength === 5_242_880` |

#### Suite U2: Session State Machine

**Goal**: Verify all state transitions and guard conditions of the session state machine (`session-state.ts`).

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-011 | `idle → recording` on `capture:start` | P0 | State is `recording` after `start()` |
| UNIT-012 | `recording → paused` on `capture:pause` | P0 | State is `paused` after `pause()` from `recording` |
| UNIT-013 | `paused → recording` on `capture:resume` (device valid) | P0 | State is `recording` after `resume()` |
| UNIT-014 | `recording → processing` on `capture:stop` | P0 | State is `processing` after `stop()` |
| UNIT-015 | `paused → processing` on `capture:stop` | P0 | State is `processing` after `stop()` from `paused` |
| UNIT-016 | `paused → processing` after 4-hour timer fires | P0 | 4-hour auto-stop: `stop()` is called internally; state → `processing`; `session:auto-stopped` emitted with `reason: 'pause-timeout'` |
| UNIT-017 | `capture:pause` while chunk upload in flight does not abort in-flight upload | P0 | In-flight `AbortController` is not signaled on pause; `this.uploads` retains the in-progress entry |
| UNIT-018 | `recording → recovery` on dual-device-loss | P0 | When both mic and loopback device events fire `removed`, state transitions to `paused` and the modal payload is emitted |
| UNIT-019 | Stop from `recording` sets `ended_at` and `duration_seconds` on the session row | P0 | DB session row has non-null `ended_at` and `duration_seconds > 0` after `stop()` |
| UNIT-020 | Pause indicator emitted: amber, frozen timer, zero VU | P1 | `session:status-changed` emitted with `newStatus: 'paused'` |

#### Suite U3: Preflight Checks

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-031 | No mic device detected + mic enabled → returns `{ micAvailable: false }` | P1 | `preflight()` with mock that returns empty devices returns warning flag |
| UNIT-032 | System audio render endpoint silent → returns `{ systemAudioSilent: true }` | P1 | `preflight()` with mock reporting silence returns soft-warning flag |

#### Suite U4: Retry Policy

**Goal**: Verify exponential backoff, retriable/non-retriable classification, and permanent failure.

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-033 | Attempt 0 delay is `BASE_DELAY_MS = 2000` ms | P0 | `delayFor(0) === 2000` |
| UNIT-034 | Delay is capped at `MAX_DELAY_MS = 60000` ms | P0 | `delayFor(10) === 60000` |
| UNIT-035 | 401/403 is not retriable at any attempt | P0 | `shouldRetry(401, 0) === false`; `shouldRetry(403, 0) === false` |
| UNIT-036 | 400 is not retriable | P0 | `shouldRetry(400, 0) === false` |
| UNIT-037 | 429 and 5xx are retriable until attempt 5 | P0 | `shouldRetry(429, 4) === true`; `shouldRetry(429, 5) === false` |
| UNIT-037b | Attempt ≥ MAX_ATTEMPTS (5) is never retriable | P0 | `shouldRetry(200, 5) === false` |

#### Suite U5: AssemblyAI Client Security Contracts

**Goal**: Verify the security and correctness contracts specified in §4.4.1.

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-056 (moved) | `uploadChunk` reads file as Buffer (not ReadableStream) | P0 | With a 100-byte test file, `fs.promises.readFile` is called (not `createReadStream`) |
| UNIT-076 | Every `request()` call includes `redirect: 'manual'` | P0 | Spy on `fetch`; assert `init.redirect === 'manual'` for upload, submit, and poll calls |
| UNIT-077 | 3xx response throws `ProviderError('redirect_rejected')` | P0 | Mock `fetch` returning status 301; assert `ProviderError.code === 'redirect_rejected'` is thrown |
| UNIT-078 | `sanitizeProviderBody` strips query strings from error body | P0 | Input `"error at https://api.assemblyai.com/v2/upload?token=secret123abc"` → output does not contain `token=secret123abc` |
| UNIT-079 | `sanitizeProviderBody` redacts token-like strings (≥16 alphanumeric) | P0 | Input `"key: abcdefghijklmnop"` → output `"key: <redacted>"` |
| UNIT-080 | `sanitizeProviderBody` truncates to 200 chars after stripping | P1 | 300-char input → output ≤ 200 chars |
| UNIT-081 | `classifyStatus` maps 401 → `auth_failed`, 429 → `rate_limited`, 500 → `provider_5xx` | P0 | Direct function test for each status code |
| UNIT-082 | `classifyHttpError` maps `AbortError` → `timeout`, unknown → `network` | P0 | Direct function test |
| UNIT-083 | `uploadChunk` throws `ProviderError('bad_request')` when file > 5 MB | P0 | Mock file stat returning 6 MB; assert `ProviderError.code === 'bad_request'` |
| UNIT-084 | Authorization header value never appears in any logged field | P0 | Spy on `logger`; call `uploadChunk` with a mock 401 response; assert no log argument contains the mock API key string |
| UNIT-085 | `AbortSignal.timeout` composes with caller AbortSignal via `AbortSignal.any` | P1 | Mock that times out after 5 ms; assert `ProviderError.code === 'timeout'` |

#### Suite U6: IPC Error Classification (`withErrorWrapper`)

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-086 | `ProviderError('auth_failed')` → `{ ok: false, error: { code: 'provider_auth_failed' } }` | P0 | Wrap a handler that throws `new ProviderError('auth_failed', 401, '')`; assert returned code |
| UNIT-087 | `ProviderError('rate_limited')` → `provider_rate_limited` | P0 | Same pattern |
| UNIT-088 | `ZodError` → `{ code: 'invalid_argument' }` | P0 | Wrap handler that throws `new ZodError([])`; assert code |
| UNIT-089 | `BetterSqlite3.SqliteError` → `{ code: 'internal_error' }` | P0 | Wrap handler that throws a mock SqliteError |
| UNIT-090 | Unknown error → `{ code: 'internal_error', logId: <uuid> }` | P0 | Wrap handler that throws `new Error('unexpected')`; assert `logId` is a UUID and `message` is `"An unexpected error occurred..."` |
| UNIT-091 | Renderer never receives raw `error.message` from main | P0 | Assert `result.error.message` is a fixed pre-approved string, never the thrown error's `.message` property |
| UNIT-092 | `sanitizeForLog` redacts `authorization` and `apiKey` fields | P0 | `sanitizeForLog({ authorization: 'secret', data: 'ok' })` → `{ authorization: '<redacted>', data: 'ok' }` |

#### Suite U7: SQLite Schema and FTS5 Triggers

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-093 | Migration runner creates all 6 tables (sessions, chunks, segments, speaker_label_overrides, settings, schema_version) | P0 | After `runMigrations()`, `SELECT name FROM sqlite_master WHERE type='table'` contains all 6 names |
| UNIT-094 | FTS5 `segments_fts` table exists and is queryable | P0 | `SELECT * FROM segments_fts WHERE segments_fts MATCH 'hello'` does not throw |
| UNIT-095 | INSERT trigger: inserting a segment inserts into segments_fts | P0 | Insert segment with text "hello world"; `SELECT rowid FROM segments_fts WHERE segments_fts MATCH 'hello'` returns that segment's id |
| UNIT-096 | UPDATE trigger: updating segment text updates segments_fts | P0 | Insert then update; old term no longer matches; new term matches |
| UNIT-097 | DELETE trigger: deleting segment removes from segments_fts | P0 | Insert then delete; FTS match returns empty |
| UNIT-098 | `chunks` table `ON DELETE CASCADE` from sessions: deleting a session deletes its chunks | P0 | Insert session + chunk; delete session; `SELECT * FROM chunks WHERE session_id = ?` returns empty |
| UNIT-099 | `chunks.status` CHECK constraint rejects invalid values | P1 | Attempting `INSERT INTO chunks(status) VALUES('invalid')` throws a constraint error |
| UNIT-100 | `speaker_label_overrides` PRIMARY KEY `(session_id, original_label)` prevents duplicates | P1 | Two upserts with same key should not create duplicate rows |

#### Suite U8: `stitchStreamLabels` Algorithm

**Goal**: Verify all correctness claims documented in §4.7.1.

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-060 | Chunk 1: all labels get fresh global labels | P0 | Chunk 1 with labels `{A, B}` → `globalAssign[1]` has entries for both with unique `G0`, `G1` |
| UNIT-061 | Same-speaker match across boundary (case (b)) | P0 | Chunk 1 label A ends at 9.5 s; chunk 2 label A starts at 10.2 s; after stitch, both map to same global label |
| UNIT-062 | New speaker in chunk 2 gets a fresh global label never reused from chunk 1 | P0 | Chunk 1 has `{A}`; chunk 2 has `{A, B}` with no overlap for B; B → new `G<n>` not equal to A's global label |
| UNIT-063 | Duration-weighted: long-overlap wins over short-overlap | P0 | Two candidates: `curr=A ∩ prev=A` = 800 ms, `curr=A ∩ prev=B` = 200 ms; A→A wins, not A→B |
| UNIT-064 | Low-confidence overlap (< MIN_OVERLAP_MS = 100 ms) treated as new speaker | P0 | Overlap of 50 ms → new global label, not matched to prev |
| UNIT-065 | Low-ratio overlap (< MIN_OVERLAP_RATIO = 0.30) treated as new speaker | P0 | 200 ms overlap on a 1200 ms shorter side (ratio = 0.17) → new global label |
| UNIT-066 | Greedy 1:1: once a prev-label is matched, it cannot be matched again | P0 | Two current labels `A` and `B` both strongly overlap prev label `A`; the higher-overlap current wins; the other gets a new label |
| UNIT-067 | Tie-breaking is deterministic: repeated calls with same input produce same output | P0 | Run `stitchStreamLabels` twice on same input; output globalLabels are identical |
| UNIT-068 | Tie-breaking secondary key: shorter-side presence (window presence) | P1 | Two pairs with equal `overlapMs`; pair with higher shorter-side presence wins |
| UNIT-069 | Tie-breaking tertiary key: lexicographic on `currLabel` | P1 | Two pairs with equal overlap and equal presence; lexicographically smaller `currLabel` wins |
| UNIT-070 | 3-speaker chunk boundary: all three labels matched correctly | P0 | Chunk boundary with A, B, C on each side; all three stitch correctly to their respective globals |
| UNIT-071 | False split (conservative): ambiguous label assigned new global, not merged | P0 | Overlap exactly at `MIN_OVERLAP_RATIO`-1 threshold → new global (not merged) |
| UNIT-072 | OVERLAP_WINDOW_MS = 1500 boundary: utterance at 500 ms before boundary is included | P1 | Utterance at `chunkStart - 1400` ms is included in the overlap window |
| UNIT-073 | Utterance entirely outside the 1500 ms boundary window is excluded from matching | P1 | Utterance at `chunkStart - 2000` ms does not contribute to overlap matrix |
| UNIT-074 | Output length equals total utterances across all chunks | P0 | Sum of utterances in all input chunks equals length of output array |
| UNIT-075 | All-silent chunks (no utterances) handled without error | P1 | Empty utterance list → algorithm returns empty array, no throw |

#### Suite U9: Diarization Merge (`mergeStreams`)

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-042 | Mic utterances are relabeled to `"You"` | P0 | Input mic utterances with labels `A`, `B`; all output segments have `speakerLabel === 'You'` |
| UNIT-043 | System utterances retain their global stitched labels | P0 | System utterances keep `G0`, `G1` labels |
| UNIT-044 | `stream` field is correctly set for each segment (`mic` vs `system`) | P0 | Output segments from mic input have `stream === 'mic'`; from system have `stream === 'system'` |
| UNIT-045 | Clock-drift offset is applied: system utterances shifted by `systemStart - micStart` | P0 | With `systemStartWallClock - micStartWallClock = 200`, a system utterance at `startMs: 1000` becomes `startMs: 1200` |
| UNIT-046 | Output is sorted by `startMs` ascending (merged timeline) | P0 | Input with interleaved timestamps → output in monotonically increasing `startMs` order |

#### Suite U10: Session Finalizer

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-038 | All chunks `transcribed` → session status `completed` | P0 | `finalizeIfReady()` with all chunks in `transcribed` state → `sessionRepo.updateStatus` called with `completed` |
| UNIT-039 | Mix of `transcribed` and `permanently_failed` → `completed_with_failures` | P0 | At least one `transcribed`, at least one `permanently_failed` → `completed_with_failures` |
| UNIT-040 | Zero transcribed chunks → `failed` | P0 | All chunks `permanently_failed` → `failed` |
| UNIT-041 | In-flight chunks (pending/uploading/polling/failed) → finalizer returns without changing status | P0 | If any chunk has status `uploading` → `updateStatus` not called |

#### Suite U11: React Router Guards

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-101 | `rootGuard`: no privacy ack → redirects to `/first-run/privacy` | P0 | Mock IPC returning `{ acknowledged: false }`; `rootGuard` returns `redirect('/first-run/privacy')` |
| UNIT-102 | `privacyAckGuard`: no ack → redirects to `/first-run/privacy` | P0 | Same mock; accessing `/first-run/api-key` redirects |
| UNIT-103 | `setupCompleteGuard`: no API key → redirects to `/first-run/api-key` | P0 | Mock `apikey:exists` returning `false`; accessing `/library` redirects |
| UNIT-104 | `setupCompleteGuard`: both ack + key present → allows route | P0 | Mock both returning true; guard returns `null` (allow) |

#### Suite U12: Audio Retention (FR-CFG-4)

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-058 | `keep_raw_audio=false` + `completed` → audio directory deleted | P0 | `applyAudioRetention()` calls `fs.rm` on the recordings directory and sets `raw_audio_path = NULL` |
| UNIT-059 | `keep_raw_audio=false` + `completed_with_failures` → audio kept (for retry) | P0 | `applyAudioRetention()` does NOT delete the audio directory |
| UNIT-059b | `status='failed'` → audio force-retained regardless of setting | P0 | `keep_raw_audio=false` + `failed` → no deletion |

#### Suite U13: API Key / safeStorage

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-056 | API key is encrypted via `safeStorage.encryptString` before write | P0 | Spy on `safeStorage.encryptString`; assert it is called when `apikey:set` is invoked |
| UNIT-057 | API key is never returned to the renderer via any IPC channel | P0 | Intercept all IPC responses after calling `apikey:exists`; assert no response contains the key value |

#### Suite U14: Export Rendering

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-048 | Plain text export: contains speaker labels and text without timestamps | P1 | `renderText(segments, overrides)` output includes `"You: "` and `"Speaker 1: "` |
| UNIT-049 | Markdown export: segments rendered as `**You:**` headings | P1 | `renderMarkdown()` produces `**You:**` prefix on mic segments |
| UNIT-050 | JSON export: each segment has `start`, `end`, `speakerLabel`, `text` fields | P1 | `renderJson()` output parsed as JSON; first element has those keys |

#### Suite U15: FTS5 Search and Snippet Rendering

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-052 | `SegmentRepository.search("action item")` returns matching segments | P0 | Insert segment with text "discuss the action item"; search returns that segment |
| UNIT-053 | Snippet uses `char(2)` / `char(3)` (STX/ETX) markers, not HTML tags | P0 | Snippet string contains `\x02` and `\x03` characters, NOT `<mark>` |
| UNIT-054 | `SearchBar` renders `<mark>` JSX by splitting on STX/ETX characters | P0 | React render test: snippet with `\x02action item\x03` → `<mark>` element wrapping "action item" |
| UNIT-055 | `SearchBar` contains no `dangerouslySetInnerHTML` | P0 | Static code assertion / grep: `dangerouslySetInnerHTML` must not appear in `SearchBar.tsx` |

#### Suite U16: Session Card Status Badge

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-051 | Status badge class maps correctly for all 6 statuses | P0 | `recording` → `badge-error`; `paused` → `badge-warning`; `processing` → `badge-info`; `completed` → `badge-success`; `completed_with_failures` → `badge-warning`; `failed` → `badge-error` |

#### Suite U17: Provider-Unreachable Banner

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| UNIT-047 | After 3 consecutive 5xx failures, `asr:provider-banner { visible: true }` is emitted | P0 | Simulate 3 `ProviderError('provider_5xx')`; assert `win.webContents.send` called with `asr:provider-banner` payload |
| UNIT-047b | Banner clears on next successful upload | P1 | After banner fires, simulate success; assert `{ visible: false }` emitted |

---

### 3.2 Integration Tests

Integration tests exercise two or more modules together against a real (in-memory or temp-file) SQLite database. No live network: AssemblyAI is mocked at the `fetch` level (MSW or `vi.mock`). Framework: Vitest with real `better-sqlite3` opened on a temp directory.

#### Suite I1: DB-First Chunk Handoff (L3 Contract)

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-001 | After 10 s of PCM input, a WAV file exists on disk AND a `chunks` row with `status='pending'` exists in DB | P0 | Both conditions true after chunk boundary |
| INT-002 | If app is "killed" after file write but before DB commit (simulated by wrapping transaction in a failing mock), orphan file is detected on recovery | P0 | Recovery scan inserts a new `chunks` row for the orphaned WAV file |
| INT-003 | No `chunks` row exists before the WAV file is durably written | P0 | Inject a delay between fsync and INSERT; verify no DB row exists during the gap |

#### Suite I2: Dual-Stream Capture (Functional)

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-004 | Mic-only mode: no loopback chunks appear in the `chunks` table | P0 | After recording with `source='mic'`, `SELECT * FROM chunks WHERE stream='system'` returns empty |
| INT-005 | System-audio-only mode: no mic chunks | P0 | `source='system'` → `SELECT * FROM chunks WHERE stream='mic'` empty |
| INT-006 | Both streams: mic and system chunks interleaved by creation time | P0 | `SELECT stream, seq FROM chunks ORDER BY created_at` alternates `mic`/`system` in expected proportion |

#### Suite I3: Chunk Processor — Upload Pipeline

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-007 | Pending chunk transitions through `uploading → polling → transcribed` with mocked AssemblyAI | P0 | After one full tick cycle with mock returning `status:'completed'`, chunk is `transcribed` and segments are inserted |
| INT-008 | 3-parallel-upload concurrency cap honored: only 3 uploads start simultaneously | P0 | With 10 pending chunks and a slow mock, `this.uploads.size` never exceeds 3 |
| INT-009 | Network disconnect (mock `fetch` throws): chunk stays `uploading` and is re-tried next tick | P0 | After first tick fails, `retry_count` increments; chunk re-queued |
| INT-010 | After 5 failed attempts, chunk becomes `permanently_failed` | P0 | 5 simulated failures → `status='permanently_failed'`, `retry_count=5` |
| INT-011 | 401 response: chunk immediately `permanently_failed`, session transitions to `failed`, `asr:provider-banner` NOT shown (auth failure is different from 5xx unreachable) | P0 | Mock 401; session → `failed`; banner not emitted |

#### Suite I4: Session Finalizer Integration

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-012 | Happy path: all chunks transcribed → session `completed`, `session:status-changed` pushed | P0 | Full DB state after finalizer runs |
| INT-013 | FR-TR-2-FALLBACK path: single session-wide upload at stop | P1 | With `LIZMEET_ASR_MODE='full-session'`, only 1 upload is made at `stop()` (2 uploads if both streams active) |

#### Suite I5: FTS5 Search Integration

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-014 | Searching across 50 sessions with 100 segments each completes within 300 ms | P1 | Timing assertion with `performance.now()` |
| INT-015 | Concurrent write (segment INSERT) and FTS5 search on same DB: no lock contention | P1 | Sequential insert + search under WAL mode; no SQLITE_BUSY error |

#### Suite I6: Library Filter and Pagination

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-016 | `findAll({ status: 'completed' })` returns only completed sessions | P1 | Assert no `failed` or `recording` sessions in result |
| INT-017 | Date range filter: `dateRange: { from: '2026-01-01', to: '2026-01-31' }` | P1 | Sessions outside that range excluded |
| INT-018 | `findAll()` ordered by `created_at DESC` | P1 | Most recent session first |

#### Suite I7: Audio Retention Integration

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-019 | `keep_raw_audio=false` + `completed` → files deleted from `userData/recordings/` | P0 | `fs.existsSync(recordingsDir)` is `false` after finalizer runs |
| INT-020 | Retry affordance: `RetryPanel` button is disabled when `raw_audio_path IS NULL` | P1 | DB-driven: query session after deletion; `raw_audio_path === null`; component prop `disabled === true` |

#### Suite I8: Crash Recovery

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-021 | Recovery flow: `recording` session with orphan WAV files → chunks re-inserted as `pending` | P0 | After simulated crash (session row in `recording`, WAV files present, no `chunks` rows), recovery inserts chunk rows |
| INT-022 | Stale session (> 24 h): auto-finalized to `failed`, not re-queued | P0 | Session with `started_at = 25 hours ago` → `status='failed'` after recovery run |
| INT-023 | Recovery modal shown for non-stale in-progress sessions | P1 | `SessionRepository.findAll({ status: ['recording', 'paused'] })` returns candidate; UI layer tested in E2E |

#### Suite I9: Performance Benchmarks

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| INT-024 | Library page: 200 sessions loaded within 500 ms | P1 | Insert 200 sessions; `SessionRepository.findAll()` + virtual list render time < 500 ms |
| INT-025 | FTS5 search across 100k segments completes within 300 ms (M5) | P1 | Insert 100k rows; time `SegmentRepository.search()` |

---

### 3.3 API / IPC Contract Tests

These tests verify the IPC channel registry contracts: correct channel names, typed req/res, error wrapper behavior. They run at the module level against the handlers with a stub main process.

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| API-001 | `session:list` handler returns `{ ok: true, data: Session[] }` | P0 | Handler invoked with valid args; response matches schema |
| API-002 | `session:list` with invalid args (bad type) returns `{ ok: false, error: { code: 'invalid_argument' } }` | P0 | Zod validation triggered |
| API-003 | `capture:start` returns `{ ok: true, data: { sessionId: string } }` | P0 | Handler invoked |
| API-004 | `capture:loopback-chunk` with oversized buffer: `{ ok: false, error: { code: 'chunk_too_large' } }` | P0 | 6 MB buffer → error code |
| API-005 | `apikey:set` stores via `safeStorage.encryptString`, not plaintext | P0 | Spy confirms `encryptString` called |
| API-006 | `apikey:exists` returns `boolean`, never the key value | P0 | Response is `{ ok: true, data: boolean }` |
| API-007 | `privacy:get` returns `{ acknowledged: boolean, content: string }` | P0 | Shape assertion |
| API-008 | `privacy:set` stores `{ noticeHash, timestamp, appVersion }` in settings table | P0 | DB assertion after invoke |
| API-009 | `segment:search` returns `SearchResult[]` with STX/ETX snippet markers | P0 | No `<mark>` in snippet field |
| API-010 | `transcript:retry-chunk` with `rawAudioPath === null` returns `{ ok: false, error: { code: 'no_audio_for_retry' } }` | P1 | Error code when audio deleted |
| API-011 | All 26 channels from `CHANNELS` have registered `ipcMain.handle` stubs | P0 | Channel enumeration test |

---

### 3.4 E2E Tests

E2E tests drive the full Electron application. Use Playwright with `@playwright/test` and Electron launch. Tests require a real AssemblyAI API key injected via `LIZMEET_DEV_API_KEY` env var (or a local mock HTTP server for CI).

#### Suite E1: First-Run Flow and Gate Guards

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| E2E-001 | Fresh install: app opens to `/first-run/privacy`, not `/library` | P0 | URL is `/first-run/privacy` on first launch with no DB |
| E2E-018 | Privacy notice contains all required text (provider name, data path, retention, third-party disclaimer, off-ramp) | P0 | Assert page contains: "AssemblyAI", "uploaded to the provider in chunks", "deleted after transcription", "responsible for any consent", "do not proceed" |
| E2E-019 | Continue button disabled until checkbox checked | P0 | Button has `disabled` attribute before check; enabled after |
| E2E-020 | Navigating directly to `/library` before ack redirects to `/first-run/privacy` | P0 | URL redirected |
| E2E-021 | After privacy ack but before API key: `/library` redirects to `/first-run/api-key` | P0 | URL redirected |
| E2E-022 | After both ack + key: `/library` loads successfully | P0 | Library page visible |
| E2E-016 | "Test connection" button: valid key shows green check; invalid key shows error | P0 | UI state after each action |

#### Suite E2: Recording Flow

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| E2E-001b | "Start Recording" button visible on home screen | P0 | Button selector present |
| E2E-002 | Recording indicator visible within 500 ms of Start | P0 | Pulsing red indicator and `HH:MM:SS` timer appear |
| E2E-003 | VU meters update for both streams (when both active) | P1 | Progress bar elements respond within 100 ms of audio |
| E2E-004 | Pause: indicator turns amber, timer freezes; Resume: indicator turns red, timer resumes | P0 | CSS class assertion; timer stops incrementing during pause |
| E2E-005 | Stop: app transitions to library; session card shows "Transcribing..." (processing) | P0 | Session card with `processing` status badge visible |
| E2E-007 | No live transcript pane visible during recording | P0 | Transcript section not present in recording page DOM |

#### Suite E3: Transcript Review

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| E2E-006 | Failed-chunk placeholder shows `[transcription failed for HH:MM:SS – HH:MM:SS]` and Retry button | P1 | Placeholder text and retry button visible in transcript |
| E2E-008 | Rename session title: new title persists after app restart | P1 | Re-open app; session shows new title |
| E2E-009 | Mic-stream segments display literal "You" and a non-color marker (icon/glyph) | P0 | Assert element contains text "You" and an icon element (e.g., SVG `UserIcon`) |
| E2E-010 | Rename "Speaker 1" to "Alice": all of Alice's segments update | P1 | After rename, no segments show "Speaker 1" (only "Alice") |
| E2E-011 | Copy full transcript to clipboard: pasted text includes speaker labels | P1 | `navigator.clipboard.readText()` contains "You:" prefix |
| E2E-012 | Export as Markdown: file opens correctly; contains speaker labels | P1 | `fs.readFileSync(exportPath)` contains `**You:**` |

#### Suite E4: Session Library

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| E2E-013 | Session persists after app restart: same title, status, duration | P0 | Re-launch; library shows session with correct metadata |
| E2E-014 | Session card shows all 5 fields: title, date, duration, status, speaker count | P0 | Assert all 5 elements present on card |
| E2E-015 | Delete session: confirmation dialog appears; after confirm, session removed from library and audio files deleted | P1 | Post-delete: session not in list; `userData/recordings/<id>` directory gone |
| E2E-023 | Search "action item": matching sessions and highlighted utterances appear | P0 | Search results contain the session; `<mark>` elements visible |

#### Suite E5: Settings

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| E2E-017 | Settings panel: chunk duration change persists; audio device options visible | P1 | After changing chunk to 5 s and restarting, setting reads 5 |
| E2E-024 | Settings → Privacy: privacy notice text visible; Revoke button present | P1 | Privacy sub-panel accessible and shows notice content |

---

### 3.5 Manual / Empirical Tests

These tests require real hardware, real network, and recorded sessions. They correspond to PRD success metrics and the §11.5.4 exit gate.

#### Suite GATE: §11.5.4 Exit Gate — Chunked vs. Full-Session DER

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| GATE-001 | Run §11.3 procedure: 5 sessions × Config A (chunked, §4.7.1 stitching) vs. Config B (full-session) | P0 | `Δ_DER ≤ 5 pp` (PASS) or `> 5 pp` (FAIL → switch to FR-TR-2-FALLBACK). Results committed to `tools/diarization-gate/results/<date>.json`. This is Phase 3 Wave 1 Task 1 and is BLOCKING for Wave 2. |

**Procedure**:
1. Collect 5 sessions from the PRD §3.1 test set on the v1 reference machine (2 × 1:1 calls, 3 × small-meeting sessions).
2. For each session, run Config A (10 s chunks, `stitchStreamLabels` with OVERLAP_WINDOW_MS=1500, MIN_OVERLAP_MS=100, MIN_OVERLAP_RATIO=0.30) and Config B (single upload).
3. Score each against ground-truth speaker annotations using `pyannote.metrics.diarization.DiarizationErrorRate` with collar=0.25 s, `ignore_overlap=False`.
4. Compute `Δ_DER = mean(DER_A) - mean(DER_B)`.
5. Record all 10 DER values, stitching audit trail, and AssemblyAI transcript IDs.

Expected outcome per literature prior (§11.5.1): `Δ_DER ≈ 2.5 ± 1.5 pp`.

#### Suite PERF: Performance (NFR §5.1)

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| PERF-001 | Cold start to "Ready to record" ≤ 3 seconds on reference machine | P1 | Measured with stopwatch from double-click to recording button enabled |
| PERF-002 | Recording 60 minutes: CPU overhead ≤ 10% above idle baseline | P1 | Windows Task Manager during recording vs. idle |
| PERF-003 | Recording 60 minutes: RAM overhead ≤ 200 MB above idle baseline | P1 | Process memory measured via Task Manager |
| PERF-004 | M3: time from Stop to transcript-ready on 60-min session ≤ 5 min (P95 over 20 runs) | P0 | App-side timing from `ended_at` to `session:status-changed(completed)` |
| PERF-005 | M5: search latency ≤ 300 ms (P95) with 200-session library | P1 | App-side timing from keystroke to results rendered |

#### Suite M1M2: Accuracy Metrics

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| M1-001 | WER ≤ 10% mean across 10-session clear-audio test set (PRD §3.1) | P0 | Computed per PRD §3.1 protocol |
| M2-001 | DER ≤ 15% mean across 8-session diarization subset (PRD §3.1) | P0 | Computed per PRD §3.1 protocol; same sessions as GATE-001 provide baseline |

---

### 3.6 Security Tests

These are targeted tests for the security properties enforced by the spec.

| ID | Test Case | Priority | Assertion |
|----|-----------|----------|-----------|
| SEC-001 | API key file (`credentials/api-key.bin`) is binary, not plaintext | P0 | `hexdump` of the file: no ASCII sequence matches the key string; file starts with DPAPI header bytes |
| SEC-002 | API key does not appear in any log file under `userData/logs/` after 10 upload cycles | P0 | `grep -r <api_key> userData/logs/` returns no results |
| SEC-003 | Raw `error.message` from a SQLite error does not appear in IPC response | P0 | Trigger a SQLite constraint violation; assert the IPC response `error.message` is `"Internal database error."` not the raw SQL error string |
| SEC-004 | `capture:loopback-chunk` with 6 MB ArrayBuffer: rejected without crashing main process | P0 | Main process remains responsive; error response returned |
| SEC-005 | SearchBar renders `<mark>` tags safely: input with `<script>` content in DB does not execute JS | P0 | Insert segment text `'<script>window.__xss=1</script>'`; render SearchBar; assert `window.__xss` is `undefined` |
| SEC-006 | Privacy acknowledgement record contains `noticeHash`, `timestamp`, `appVersion` fields | P0 | DB query on `settings` table after first-run |
| SEC-007 | Revoking privacy acknowledgement (Settings → Privacy → Revoke) blocks next recording attempt | P1 | After revoke, `capture:start` is blocked; app redirects to privacy page |

---

## 4. Test Coverage Summary

### 4.1 Coverage by Functional Area

| Area | Unit | Integration | API/IPC | E2E | Manual |
|------|------|-------------|---------|-----|--------|
| Audio Capture (dual-stream, chunking) | 10 | 6 | 2 | 3 | 0 |
| Session State Machine | 10 | 0 | 2 | 2 | 0 |
| DB-First Chunk Handoff (L3) | 1 | 3 | 0 | 0 | 0 |
| AssemblyAI Client + Security | 10 | 5 | 2 | 0 | 0 |
| IPC Error Classification | 7 | 0 | 5 | 0 | 0 |
| stitchStreamLabels Algorithm | 16 | 0 | 0 | 0 | 0 |
| Diarization Merge | 5 | 0 | 0 | 1 | 0 |
| Session Finalizer | 4 | 2 | 0 | 1 | 0 |
| SQLite Schema + FTS5 Triggers | 8 | 3 | 2 | 1 | 0 |
| React Router Guards | 4 | 0 | 0 | 3 | 0 |
| First-Run + Privacy | 2 | 0 | 2 | 4 | 1 |
| Library + Search + Filters | 5 | 5 | 2 | 3 | 0 |
| Transcript UX (labels, export) | 8 | 1 | 1 | 5 | 0 |
| Settings + API Key + SafeStorage | 4 | 1 | 3 | 2 | 0 |
| Crash Recovery | 0 | 3 | 0 | 0 | 0 |
| Exit Gate (§11.5.4) | 0 | 0 | 0 | 0 | 1 |
| Performance | 0 | 2 | 0 | 0 | 5 |
| Security | 0 | 0 | 0 | 0 | 7 |
| **Total** | **94** | **31** | **23** | **25** | **14** |

**Grand total: 187 test cases**

### 4.2 P0 Requirement Coverage

| P0 Requirement | Test Cases | Covered |
|----------------|------------|---------|
| FR-CAP-1 (Start recording) | E2E-001, E2E-001b | Yes |
| FR-CAP-2 (Dual-stream capture) | INT-001, INT-004, INT-005, INT-006 | Yes |
| FR-CAP-8 (Pause/resume) | UNIT-011–018, E2E-004 | Yes |
| FR-CAP-9 (Stop → processing) | UNIT-019, E2E-005 | Yes |
| FR-TR-1 (10-second chunking) | UNIT-001, UNIT-002 | Yes |
| FR-TR-2 (Chunked upload during recording) | INT-007, INT-008 | Yes |
| FR-TR-3 (Retry/backoff, status enum) | UNIT-033–037, INT-009–011 | Yes |
| FR-TR-4 (Merged transcript) | UNIT-038, INT-012 | Yes |
| FR-TR-5 (Speaker labels stable in session) | UNIT-039, UNIT-040, UNIT-060–075 | Yes |
| FR-TR-6 (Per-segment timestamps) | UNIT-041 | Yes |
| FR-TR-7 ("You" label + ±200ms drift) | UNIT-042–046, E2E-009 | Yes |
| FR-UX-1 (No live transcript during recording) | E2E-007 | Yes |
| FR-UX-3 ("You" label + non-color marker) | UNIT-047, E2E-009 | Yes |
| FR-LIB-1 (Library persists across restarts) | E2E-013 | Yes |
| FR-LIB-2 (Session card metadata + status badges) | UNIT-051, E2E-014 | Yes |
| FR-LIB-3 (FTS5 full-text search) | UNIT-052–055, INT-014, INT-015, E2E-023 | Yes |
| FR-CFG-1 (API key required) | E2E-016, E2E-022 | Yes |
| FR-CFG-2 (API key in safeStorage) | UNIT-056, UNIT-057, SEC-001, SEC-002 | Yes |
| §5.3.1 (Privacy notice + ack) | E2E-018, E2E-019, SEC-006 | Yes |
| §5.2 (Crash recovery) | INT-021, INT-022 | Yes |
| §11.5.4 (Exit Gate) | GATE-001 | Yes |
| §4.7.1 (stitchStreamLabels) | UNIT-060–075 | Yes |
| §4.9.1 (IPC error classification) | UNIT-086–092 | Yes |
| §4.1 (Schema + FTS5 triggers) | UNIT-093–100 | Yes |
| React Router guards | UNIT-101–104, E2E-020–022 | Yes |
| DB-First Write (L3) | UNIT-006, INT-001–003 | Yes |

**P0 requirements covered: 26/26 (100%)**

---

## 5. Risk-Targeted Testing

### 5.1 Highest-Risk Areas

**Risk 1: §11.5.4 Exit Gate (`stitchStreamLabels` DER degradation)**
This is the single highest-risk item in the entire feature. If `Δ_DER > 5 pp`, the architecture must switch to FR-TR-2-FALLBACK.
- Primary coverage: GATE-001 (empirical), UNIT-060–075 (algorithm correctness)
- Secondary coverage: INT-012 (session finalization with stitched segments)
- The stitching algorithm unit tests (UNIT-060–075) are specifically designed to catch the three failure modes Apollo identified in r1: new-speaker assignment, boundary-crossing utterances, and duration weighting.

**Risk 2: Concurrent-write race conditions in DB-First handoff**
The WAV-file-before-DB-INSERT ordering is the crash-recovery contract.
- Coverage: UNIT-006, INT-001, INT-002, INT-003, INT-021

**Risk 3: IPC error leakage (auth key, raw error.message to renderer)**
Apollo flagged this as High severity in the spec review.
- Coverage: UNIT-076–085 (client security), UNIT-086–092 (error wrapper), SEC-001–004

**Risk 4: AssemblyAI provider starvation (stuck poll blocking other polls)**
Fixed in r2 by `Promise.allSettled`, but must be verified.
- Coverage: INT-008 (concurrency cap), UNIT-085 (AbortSignal composition)

**Risk 5: FTS5 XSS via snippet markers**
Apollo flagged `dangerouslySetInnerHTML` as a stored-XSS surface (resolved in r2 by STX/ETX markers).
- Coverage: UNIT-053–055, SEC-005

### 5.2 Edge Cases to Target

| Scenario | Test | Coverage |
|----------|------|----------|
| Chunk boundary mid-utterance | UNIT-061 | Unit |
| Device hot-swap mid-recording (mic disconnected) | UNIT-018 (dual-loss), E2E-004 (pause indicator) | Unit + E2E |
| Network drops mid-session (5-minute outage) | INT-009 | Integration |
| App force-killed during recording | INT-021 | Integration |
| Stale crashed session > 24 hours old | INT-022 | Integration |
| Silence-only audio chunk | UNIT-075, UNIT-008 | Unit |
| 400 error from AssemblyAI (bad_request, non-retriable) | UNIT-036, API-002 | Unit + API |
| 401 auth failure → session immediately failed | INT-011 | Integration |
| Provider 5xx × 3 → banner shown | UNIT-047 | Unit |
| safeStorage.decryptString throws on read | UNIT-092 (isSafeStorageError path) | Unit |
| Privacy notice revoked mid-session attempt | SEC-007 | Security |
| 6 MB loopback chunk (oversized) | UNIT-009, API-004, SEC-004 | Unit + API + Security |
| FTS5 search with malicious content in DB | SEC-005 | Security |
| Sleep/hibernate during recording | UNIT-016 (watchdog clock-jump detection) | Unit (state machine) |
| 4-hour pause auto-stop | UNIT-016 | Unit |
| Two sessions processing simultaneously | E2E-005 (library shows both) | E2E |

---

## 6. Test Data Requirements

### 6.1 Audio Fixtures (for unit tests)
- `tests/fixtures/silence-16khz-mono-10s.wav` — 10 seconds of silence at 16 kHz, mono, 16-bit PCM.
- `tests/fixtures/speech-2speaker-30s.wav` — 30 seconds of 2-speaker conversation at 16 kHz.
- `tests/fixtures/speech-4speaker-60s.wav` — 60 seconds of 4-speaker meeting at 16 kHz.
- `tests/fixtures/loopback-10s.webm` — 10-second opus/webm clip (simulates renderer MediaRecorder output).

### 6.2 AssemblyAI Mock Responses
- `tests/fixtures/assemblyai-upload-response.json` — `{ "upload_url": "https://..." }`
- `tests/fixtures/assemblyai-transcript-queued.json` — `{ "id": "test123", "status": "queued" }`
- `tests/fixtures/assemblyai-transcript-completed-2speaker.json` — completed transcript with 2 speakers and utterances.
- `tests/fixtures/assemblyai-transcript-completed-4speaker.json` — 4-speaker completed transcript.
- `tests/fixtures/assemblyai-transcript-error.json` — `{ "id": "test123", "status": "error", "error": "..." }`

### 6.3 Gate Test Sessions
Five session recordings conforming to PRD §3.1 clear-audio criteria are required for GATE-001. These must be hand-annotated with ground-truth speaker labels before the gate run.

---

## 7. CI / Automation Notes

- **Unit + Integration tests**: run on every pull request. `vitest run tests/unit tests/integration`.
- **API/IPC contract tests**: run on every pull request alongside unit tests.
- **E2E tests**: run on merge to `main`. Require `LIZMEET_DEV_API_KEY` or a mock HTTP server. `playwright test --config playwright.electron.config.ts`.
- **Security tests (automated)**: UNIT-076–085, UNIT-086–092, SEC-003–005 run as part of unit/integration suites.
- **Security tests (manual)**: SEC-001, SEC-002, SEC-006, SEC-007 require a real build and are run as part of release validation.
- **Gate test (GATE-001)**: manual, run once at Phase 3 Wave 1 before Wave 2 begins. Result committed to `tools/diarization-gate/results/`.
- **Performance tests (PERF-001–005)**: manual, run on the reference machine for release validation.
- **Coverage target**: ≥ 80% line coverage on `electron/asr/` and `electron/capture/` modules (the highest-risk code). Measured via `vitest --coverage`.

---

## 8. Dependencies and Blockers

| Dependency | Blocks | Notes |
|------------|--------|-------|
| Phase 2 (audio capture) complete | GATE-001 | Gate sessions cannot be recorded before Phase 2 is built |
| Phase 2 (audio capture) complete | INT-001–006 | Real WAV file writes required |
| `better-sqlite3` + `@electron/rebuild` installed | All INT + UNIT-093–100 | SQLite must be available |
| `LIZMEET_DEV_API_KEY` or mock server | INT-007–013, E2E suite | Live API key or MSW mock required |
| Phase 3 ASR pipeline complete | INT-007–013 | Chunk processor must be built |
| Phase 4 UI complete | E2E suite | Pages must exist |
| Phase 5 (settings + privacy) complete | E2E-016–022, API-005–008 | safeStorage and privacy flow must exist |
| GATE-001 PASS result | All Phase 3 Wave 2+ tests | Architecture locked to `chunked` only after gate passes; if FAIL, INT-013 (FR-TR-2-FALLBACK) becomes the primary integration test |

---

## 9. Acceptance Criteria Verification Summary

All PRD §12 acceptance criteria map to test cases in this plan:

| Acceptance Criterion (PRD §12) | Primary Test |
|-------------------------------|-------------|
| Start recording in ≤ 1 click | E2E-001 |
| System + mic streams capture independently | INT-001, INT-004, INT-005 |
| Recording UI: indicator, timer, VU meters | E2E-002, E2E-003 |
| Pause/resume/stop per spec | UNIT-011–019, E2E-004, E2E-005 |
| Chunked upload during recording OR fallback per §10.3 | INT-007, INT-013 |
| Slow/metered network: status badge shown | INT-009 |
| Failed uploads retry; persistent failures: placeholder + Retry | UNIT-033–037, INT-009–010, E2E-006 |
| Session card status enum: completed_with_failures, failed, badges, toasts | UNIT-051, INT-012, E2E-014 |
| Final transcript: speaker labels, timestamps, all chunks merged | UNIT-038–041, INT-012 |
| Mic-stream "You" label + non-color marker | UNIT-042, UNIT-047, E2E-009 |
| Merged mic + system timeline ≤ ±200 ms | UNIT-045 (clock offset), GATE-001 (empirical) |
| No live transcript during recording | E2E-007 |
| Rename sessions, speaker labels, copy, export | E2E-008, E2E-010, E2E-011, E2E-012 |
| Library: all required metadata on cards | E2E-014 |
| FTS5 search across library | INT-014, E2E-023 |
| Date/status filtering | INT-016, INT-017 |
| Delete removes DB rows and audio files | INT-015, E2E-015 |
| First-run blocks until privacy ack AND API key | E2E-018–022 |
| Privacy notice content: all 5 required items | E2E-018 |
| API key in OS credential store | UNIT-056, UNIT-057, SEC-001 |
| Settings: chunk duration, devices, provider, retention | E2E-017 |
| Crash recovery | INT-021, INT-022 |
| Failure-modes table §6.4 | INT-009–011, INT-021–023, UNIT-016, UNIT-017, UNIT-018 |
| Exit gate §10.3 results documented | GATE-001 |

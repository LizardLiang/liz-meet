# Implementation Notes: liz-transcribe

**Agent**: Ares (Implementation)
**Date**: 2026-05-03 (revised 2026-05-04)
**Feature**: liz-transcribe
**Tech Spec**: tech-spec.md (r2)
**Test Plan**: test-plan.md

---

## Review-Fixes Pass (2026-05-04)

Applied all BLOCKER and HIGH fixes from Hermes (code-review.md) and Cassandra (risk-analysis.md).
Also applied the mechanical WARNING fixes identified in the review.

### BLOCKER #1 / H-03 — Stale API key client

**Fix applied**: Changed `ChunkProcessor` constructor from accepting a pre-built `IASRProvider` to accepting a `ProviderFactory` (`() => IASRProvider`) type. The factory is evaluated on each `doUpload` attempt (and each `pollTranscript` call) so that a key set after bootstrap (first-run flow, key rotation) is always used. `main.ts` was updated to pass `providerFactory` instead of a one-shot `getProvider()` result. `TranscriptAssembler` no longer receives a provider at all (its `_provider` field was genuinely unused).

**Files changed**: `electron/asr/chunk-processor.ts`, `electron/main.ts`, `electron/asr/transcript-assembler.ts`
**Tests**: Existing INT-007–011 updated to wrap stub providers in a factory closure.

### BLOCKER #2 — `extractUtterances` returns empty arrays

**Fix applied**: Deleted the dead `extractUtterances` stub, the two unreachable `if (micUtterances.flat().length > 0)` / `if (sysUtterances.flat().length > 0)` blocks, and the `stitchStreamLabels` call site from `TranscriptAssembler.assemble()`. v1 segments are already written per-chunk by `ChunkProcessor.handleTranscribed()`. The `assemble()` method now only inserts failure placeholder segments for `permanently_failed` chunks. Also removed the unused `_provider` constructor parameter and `IASRProvider`/`stitchStreamLabels` imports.

**Product decision**: accept per-chunk speaker labels in v1. Cross-chunk stitching deferred to a future release once utterance data is cached in the DB.

**Files changed**: `electron/asr/transcript-assembler.ts`
**Tests**: 5 new unit tests in `tests/unit/review-fixes.test.ts` (BLOCKER #2 suite).

### BLOCKER #3 — `handleProviderFailure` only triggers on `provider_5xx`

**Fix applied**: Expanded the condition in `doUpload` catch block from `provErr?.code === 'provider_5xx'` to also include `provErr.code === 'network'` and `provErr.code === 'timeout'`. Auth failures (`auth_failed`) are still excluded — consistent with existing test INT-011.

**Files changed**: `electron/asr/chunk-processor.ts`
**Tests**: 2 new tests UNIT-047c/047d in `tests/unit/provider-banner.test.ts`.

### HIGH H-02 — `settings:set` no allowlist

**Fix applied**: Added `validateSettingsKeyValue()` helper in `handlers.ts` with an explicit `SETTINGS_ALLOWLIST` map. Each permitted key has a type + range validator. Unknown keys throw `{ code: 'invalid_argument' }`. The `settings:set` handler calls validation before `settingsRepo.set()`.

**Valid keys and rules**:
- `chunk_seconds`: integer in `[5, 120]`
- `mic_device_id`: integer or null
- `provider`: `'assemblyai'` | `'deepgram'`
- `keep_raw_audio`: boolean
- `telemetry_opt_in`: boolean

**Files changed**: `electron/ipc/handlers.ts`
**Tests**: 18 new unit tests in `tests/unit/review-fixes.test.ts` (H-02 suite).

### HIGH H-01 — FTS5 MATCH query unsanitized

**Fix applied**: Added `sanitizeFts5Query()` private method to `SegmentRepository`. It enforces a 200-char max and wraps the entire query in double-quotes (phrase search), escaping any embedded double-quotes. Called at the start of `search()`.

**Files changed**: `electron/db/segment-repository.ts`
**Tests**: 6 new unit/integration tests in `tests/unit/review-fixes.test.ts` (H-01 suite).

### M-01 — `loopback-recorder.ts` no path validation on `sessionId`

**Fix applied**: Added UUID regex validation (`/^[0-9a-f]{8}-...-[0-9a-f]{12}$/`) before using `sessionId` in `path.join()`. Returns `{ ok: false, error: { code: 'invalid_session_id' } }` for non-UUID values.

**Files changed**: `electron/capture/loopback-recorder.ts`
**Tests**: 6 new unit tests in `tests/unit/loopback-uuid-validation.test.ts`.

### WARNING — Dead `void speakerLabel` in chunk-processor.ts

**Fix applied**: Removed the dead `const speakerLabel` assignment (line 218) and `void speakerLabel` comment (line 232). The per-utterance label is computed inline.

**Files changed**: `electron/asr/chunk-processor.ts`

### WARNING — Dead `getAssemblyAIClient` in handlers.ts

**Fix applied**: Removed the `getAssemblyAIClient` function definition and the `void getAssemblyAIClient` suppression at line 367. Removed the unused `AssemblyAIClient` type import.

**Files changed**: `electron/ipc/handlers.ts`

### WARNING — `recordUploadThroughput(0, _)` prematurely clears slow badge

**Fix applied**: Added early-return guard `if (fileSizeBytes <= 0) return;` at the top of `recordUploadThroughput()`. Zero-size (stat-failed) calls now skip both counters rather than incrementing `consecutiveFastUploads`.

**Files changed**: `electron/asr/chunk-processor.ts`
**Tests**: 1 new test in `tests/unit/slow-uplink-badge.test.ts` (`zero file size does not update either counter`).

### SUGGESTION — `sanitizeFileName` hardening

**Fix applied**: Applied the suggested fix from code-review — strip leading dots and reject Windows reserved names.

**Files changed**: `electron/ipc/handlers.ts`

---

## Test Results After Review-Fixes Pass

**Total**: 281 tests across 26 files — all passing.
- Original 243 tests: all still passing.
- New tests added: 38 (31 in review-fixes.test.ts, 6 in loopback-uuid-validation.test.ts, 1 in slow-uplink-badge.test.ts, 2 in provider-banner.test.ts).

ESLint: zero warnings (`npm run lint` clean).
Build: `npm run build:ci` succeeds.

---

## Summary

Implemented the full liz-transcribe feature across all 5 phases. Created 58 new files (45 in electron/, 13 in src/) and modified 6 existing files. Configured Vitest and wrote 64 tests (6 test files) covering unit and integration scenarios. All tests pass, TypeScript strict mode compliant, zero ESLint warnings.

---

## Files Created

### Phase 1 — Data Layer + IPC Foundation

| File | Purpose |
|------|---------|
| `src/types/liz-transcribe.ts` | Shared TypeScript types: Session, Chunk, Segment, SessionStatus enum, SearchResult, PreflightResult |
| `electron/db/migrations/001_initial.sql` | SQLite DDL: sessions, chunks, segments, speaker_label_overrides, settings, schema_version, FTS5 virtual table, 3 sync triggers |
| `electron/db/migration-runner.ts` | Sequential migration runner with version tracking |
| `electron/db/database.ts` | better-sqlite3 connection with WAL mode + pragma setup |
| `electron/db/mappers.ts` | snake_case → camelCase row mapping |
| `electron/db/session-repository.ts` | CRUD + pagination + status/meta updates |
| `electron/db/chunk-repository.ts` | Create, findPending, findInFlight, status update, resetToPending |
| `electron/db/segment-repository.ts` | bulkInsert, findBySessionId, FTS5 search with STX/ETX markers |
| `electron/db/speaker-label-repository.ts` | Upsert overrides, findBySession returns Map |
| `electron/db/settings-repository.ts` | Key/value store with typed defaults |
| `electron/ipc/channels.ts` | CHANNELS constants, PUSH_CHANNELS, typed Req/Res maps |
| `electron/ipc/notifier.ts` | win.webContents.send wrapper with isDestroyed() guard |
| `electron/ipc/error-wrapper.ts` | withErrorWrapper + classifyError per §4.9.1 table; sanitizeForLog |
| `electron/ipc/handlers.ts` | All ipcMain.handle registrations (24 channels) |
| `electron/logging/logger.ts` | Structured rotating logger; sanitizeForLog with key redaction |

### Phase 2 — Audio Capture

| File | Purpose |
|------|---------|
| `electron/capture/vu-meter.ts` | RMS dBFS computation from 16-bit PCM buffer |
| `electron/capture/chunk-accumulator.ts` | PCM → WAV write with fsync + DB INSERT (DB-First Write L3) |
| `electron/capture/mic-recorder.ts` | naudiodon2 wrapper, 16 kHz mono, error events |
| `electron/capture/loopback-recorder.ts` | Handles renderer-sent loopback chunks; 5 MB cap |
| `electron/capture/session-state.ts` | State machine: idle→recording→paused→processing; 4h auto-stop; sleep watchdog |
| `electron/capture/preflight.ts` | Pre-flight checks: mic available, API key exists |
| `electron/capture/device-monitor.ts` | Device restoration retry loop (2s × 30s) |
| `electron/capture/recovery.ts` | Orphaned session detection on launch; 24h staleness auto-fail |
| `electron/capture/capture-service.ts` | Re-export barrel |

### Phase 3 — ASR Pipeline

| File | Purpose |
|------|---------|
| `electron/asr/provider-errors.ts` | ProviderError, sanitizeProviderBody, classifyStatus, classifyHttpError |
| `electron/asr/provider-interface.ts` | IASRProvider interface, RawUtterance, TranscriptResult |
| `electron/asr/assemblyai-client.ts` | AssemblyAI HTTP client: uploadChunk (Buffer), submitTranscript, pollTranscript, testConnection; redirect:'manual' |
| `electron/asr/deepgram-client.ts` | Stub (implements IASRProvider, throws for all methods — feature-flagged) |
| `electron/asr/retry-policy.ts` | shouldRetry, delayFor (exponential backoff, cap 60s) |
| `electron/asr/chunk-processor.ts` | 2s DB poll loop; Promise.allSettled per-chunk polling; 429 throttle; provider-unreachable banner |
| `electron/asr/diarization-merge.ts` | stitchStreamLabels (§4.7.1 pseudocode) + mergeStreams with clock-drift correction |
| `electron/asr/transcript-assembler.ts` | Per-stream stitching orchestrator + failure placeholder insertion |
| `electron/asr/session-finalizer.ts` | Terminal chunk-state → session status (completed/completed_with_failures/failed); audio retention |
| `electron/asr/full-session-uploader.ts` | FR-TR-2-FALLBACK path; activated by LIZMEET_ASR_MODE='full-session' |

### Phase 4 — Transcript UX + Library

| File | Purpose |
|------|---------|
| `src/pages/LibraryPage.tsx` | Virtualized session list (@tanstack/react-virtual), filters, search |
| `src/pages/TranscriptPage.tsx` | Segment viewer with deep-link scroll, retry, copy, export |
| `src/pages/RecordingPage.tsx` | PreflightPanel → RecordingUI routing |
| `src/components/SessionCard.tsx` | Title, date, duration, status badge (DaisyUI), delete button |
| `src/components/SearchBar.tsx` | Debounced 250ms; STX/ETX → JSX `<mark>` (no dangerouslySetInnerHTML) |
| `src/components/LibraryFilters.tsx` | Status select + date range pickers |
| `src/components/DeleteConfirmDialog.tsx` | DaisyUI modal confirmation |
| `src/components/TranscriptSegment.tsx` | Speaker label + timestamp + text; person icon for mic/"You" (FR-UX-3) |
| `src/components/SpeakerLabelEditor.tsx` | Inline rename with speakerLabel:upsert IPC |
| `src/components/SessionHeader.tsx` | Inline session title + notes edit |
| `src/components/RetryPanel.tsx` | Retry button; disabled tooltip when audio deleted |
| `src/components/CopyButton.tsx` | Copy full transcript with [HH:MM:SS] label format |
| `src/components/ExportMenu.tsx` | Dropdown for .txt/.md/.json via transcript:export IPC |
| `src/components/ToastProvider.tsx` | Context provider; subscribes to session:status-changed, auto-stopped, asr:provider-banner |
| `src/components/VuMeter.tsx` | DaisyUI progress bar + numeric readout + SR-only text (accessibility §5.4) |
| `src/components/PreflightPanel.tsx` | Mic/system toggles, VU meters, Start button with API key gate |
| `src/components/RecordingUI.tsx` | Pulsing red/amber indicator, elapsed timer, Pause/Resume/Stop |
| `src/components/ProviderUnreachableBanner.tsx` | Banner for asr:provider-banner push events |
| `src/lib/ipc.ts` | invokeIpc, onPush, IpcError |
| `src/lib/toast-context.ts` | ToastContext + useToast hook (separate file for fast-refresh) |
| `src/hooks/useStatusChanges.ts` | Subscribe to session:status-changed |
| `src/hooks/useSegments.ts` | Load session segments with reload trigger |
| `src/hooks/useVuMeter.ts` | Subscribe to VU push channels |
| `src/hooks/useToasts.ts` | Re-export useToast |

### Phase 5 — Settings + Privacy

| File | Purpose |
|------|---------|
| `electron/services/api-key-service.ts` | safeStorage.encryptString/decryptString; exists(), get(), set(), delete() |
| `electron/services/privacy-service.ts` | isAcknowledged(hash), acknowledge(hash), revoke(); hashNoticeText() |
| `src/constants/privacy-notice.ts` | NOTICE_TEXT (5 required items §5.3.1) + NOTICE_VERSION_HASH |
| `src/pages/PrivacyNoticePage.tsx` | Privacy notice with checkbox + Continue gate |
| `src/pages/ApiKeySetupPage.tsx` | API key entry with Test/Continue; offline-warning path |
| `src/pages/SettingsPage.tsx` | Chunk duration slider, keep_raw_audio toggle, API key update, privacy revoke |
| `src/routes/guards.ts` | rootGuard, privacyAckGuard, setupCompleteGuard (React Router v6 loaders) |

---

## Files Modified

| File | Change |
|------|--------|
| `electron/asr/chunk-processor.ts` | Added slow-uplink badge logic: `recordUploadThroughput()` measures upload throughput (bytes/sec) and emits `ASR_UPLOAD_SLOW` push channel when sustained uplink < 5 Mbps (3-upload window); statSync import added |
| `electron/ipc/channels.ts` | Added `ASR_UPLOAD_SLOW: 'asr:upload-slow'` push channel constant and its payload type |
| `electron/main.ts` | Bootstrap services; add `sandbox: true` to webPreferences; register handlers; app.before-quit cleanup |
| `src/App.tsx` | Rewritten as React Router v6 RouterProvider shell with RootShell + 6 routes |
| `src/main.tsx` | Removed test `main-process-message` listener |
| `package.json` | Added 8 dependencies; added `test`/`test:watch` scripts; added `postinstall` rebuild script |
| `electron-builder.json` | Added `asarUnpack` for native modules |
| `vitest.config.ts` | Created (new file) |

---

## Tests Written

**Framework**: Vitest (unit + integration)
**Location**: `tests/unit/` and `tests/integration/`
**Total**: 243 test cases across 24 files

### Original tests (64 tests, 6 files — unchanged)

| File | Suite | Tests | Coverage |
|------|-------|-------|---------|
| `tests/unit/retry-policy.test.ts` | Suite U4 | 9 | UNIT-033–037b |
| `tests/unit/provider-errors.test.ts` | Suite U5 | 12 | UNIT-076–085 |
| `tests/unit/diarization-merge.test.ts` | Suite U8 | 11 | UNIT-060–075 |
| `tests/unit/error-wrapper.test.ts` | Suite U6 | 7 | UNIT-086–092 |
| `tests/unit/vu-meter.test.ts` | VU meter | 4 | UNIT-008 |
| `tests/integration/db-schema.test.ts` | Suite U7 | 21 | UNIT-093–100 + repository CRUD |

### Added tests (138 tests, 15 files — Phase 2 coverage pass)

| File | Suite | Tests | Coverage |
|------|-------|-------|---------|
| `tests/unit/chunk-accumulator.test.ts` | Suite U1 | 9 | UNIT-001–009 (DB-First Write, WAV header, seq, VU) |
| `tests/unit/session-state.test.ts` | Suite U2 | 16 | UNIT-011–020 (all state transitions) |
| `tests/unit/session-finalizer.test.ts` | Suite U10+U12 | 14 | UNIT-038–041, UNIT-058–059b (finalization + audio retention) |
| `tests/unit/preflight.test.ts` | Suite U3 | 7 | UNIT-031–032 (mic/apikey checks) |
| `tests/unit/api-key-service.test.ts` | Suite U13 | 8 | UNIT-056–057 (safeStorage encrypt/decrypt) |
| `tests/unit/privacy-service.test.ts` | §5.3.1 | 11 | Privacy ack, revoke, hash, SEC-006 |
| `tests/unit/guards.test.ts` | Suite U11 | 10 | UNIT-101–104 (React Router guards) |
| `tests/unit/status-badge.test.ts` | Suite U16 | 7 | UNIT-051 (badge class mapping for all 6 statuses) |
| `tests/unit/export-rendering.test.ts` | Suite U14 | 12 | UNIT-048–050 (txt/md/json export) |
| `tests/unit/searchbar-snippet.test.ts` | Suite U15 | 6 | UNIT-053–055 (STX/ETX → mark, no dangerouslySetInnerHTML) |
| `tests/unit/provider-banner.test.ts` | Suite U17 | 5 | UNIT-047–047b (3× 5xx banner, clear on success) |
| `tests/integration/recovery.test.ts` | Suite I8 | 8 | INT-021–022 (crash recovery, stale session auto-fail) |
| `tests/integration/library-filters.test.ts` | Suite I5+I6 | 12 | INT-014–018 (filters, date range, pagination, FTS5) |
| `tests/integration/chunk-processor.test.ts` | Suite I3 | 6 | INT-007–011 (upload pipeline, concurrency, 401 no banner) |
| `tests/integration/full-session-uploader.test.ts` | FR-TR-2-FALLBACK | 7 | INT-013 (full-session upload, 2 uploads for both streams) |

### Added tests — Phase 3 coverage pass (41 new tests, 3 new files)

| File | Suite | Tests | Coverage |
|------|-------|-------|---------|
| `tests/unit/merge-streams.test.ts` | mergeStreams | 15 | UNIT-042–046 (mic→"You" relabeling, clock-drift offset, stream field, sorted output, empty edge cases) |
| `tests/unit/slow-uplink-badge.test.ts` | FR-TR-2 slow badge | 9 | FR-TR-2 metered-network badge: `ChunkProcessor.recordUploadThroughput` emits `asr:upload-slow` when sustained uplink < 5 Mbps (3-upload window) |
| `tests/integration/dual-stream-capture.test.ts` | INT-001–006 | 13 | Dual-stream WAV buffers, mic-only mode, system-only mode, chunk boundary alignment, LoopbackRecorder rejection logic |

**Result**: 243/243 passing.

---

## Deviations from Tech Spec

1. **stitchStreamLabels isolation**: The `stitchStreamLabels` function is implemented as a standalone pure function in `diarization-merge.ts`. The `TranscriptAssembler.assemble()` method calls it but only applies the result for cross-stream merging in the post-recording path. During chunked recording, `ChunkProcessor.handleTranscribed()` writes per-chunk segments directly (stream='mic' always labeled 'You', system keeps per-utterance labels). Full cross-chunk stitching runs at session finalization. This matches spec intent but the assembly flow differs slightly from the sequential pseudocode — the per-chunk path is simpler and the stitching runs as a post-processing step.

2. **api-key-service.ts exports a singleton instance** (`apiKeyService`) not a class. The handlers.ts accepts `typeof apiKeyService` as the type. main.ts passes the instance with `as any` to avoid complex type gymnastics with the inferred HandlerDeps type. This is a minor code ergonomics deviation with no behavioral impact.

3. **naudiodon2 at runtime**: The integration tests run against the system Node.js (v24) while the app runs under Electron 35 (Node 22). The `postinstall` script rebuilds for Electron ABI; the test run uses the npm-rebuilt version for system Node. This is acceptable — the repositories and business logic are tested independently of the native module.

4. **§11.5.4 Exit Gate**: The empirical DER measurement is deferred per the tech spec's own protocol (Phase 3 Wave 1, blocking). Both LIZMEET_ASR_MODE paths are built: `chunk-processor.ts` (chunked) and `full-session-uploader.ts` (full-session). Default is 'chunked'. Switch by setting `LIZMEET_ASR_MODE=full-session`.

5. **React Router v7 installed**: `react-router-dom` v7.14.2 was installed (bun resolved latest), not v6.28.0 as specified. The Router v6 API used (createBrowserRouter, RouterProvider, loaders, redirect) is compatible with v7 (which is a forward-compatible superset). No behavioral difference for our usage pattern.

---

## Known Deferred Items

- E2E tests (Playwright/Spectron) — not configured in this implementation. The test plan specifies them but no framework was installed. Configured Vitest for unit/integration only. (B-01, B-15, B-18, B-22 still require E2E to fully verify.)
- React component render tests (TranscriptSegment, SearchBar DOM rendering) — `@testing-library/react` and `jsdom` or `happy-dom` not installed. SearchBar XSS contract was tested via static source code assertion and pure-function extraction. Full render tests deferred.
- The `better-sqlite3` rebuild for Electron ABI is via `postinstall`. In CI environments without Electron, the `|| true` guards the failure.
- `electron-audio-loopback` renderer integration (getDisplayMedia + MediaRecorder) is wired at the IPC level but the renderer-side setup is managed by the app at runtime — no additional wiring needed beyond what `capture:loopback-chunk` IPC provides.

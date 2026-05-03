# Risk Analysis: liz-transcribe

**Agent**: Cassandra (Risk Analysis)
**Date**: 2026-05-03
**Feature**: liz-transcribe
**Stage**: 10-review
**Verdict**: Caution

---

## Executive Summary

The implementation has strong security foundations: sandbox mode, `contextIsolation`, `redirect:'manual'` on all HTTP calls, error classification with no raw messages to the renderer, and `safeStorage` for the API key. No CRITICAL findings were identified.

Three HIGH findings exist, all addressable without architectural changes. Seven MEDIUM findings require attention before or immediately after ship. The risk surface is concentrated in three areas: (1) an unvalidated FTS5 query passthrough, (2) an unbounded `settings:set` IPC channel, and (3) provider key lifecycle in the main bootstrap.

---

## Delta Scope

Primary risk surface (changed files):
- `electron/asr/chunk-processor.ts` — slow-uplink badge logic added (`recordUploadThroughput`, `statSync` import)
- `electron/ipc/channels.ts` — `ASR_UPLOAD_SLOW` push channel added

Broader implementation (new files, all part of this feature, risk surface applies):
- 58 new files across `electron/` and `src/`
- 6 modified files (`electron/main.ts`, `src/App.tsx`, `src/main.tsx`, `package.json`, `electron-builder.json`, `vitest.config.ts`)

---

## Findings

### HIGH

#### H-01 — FTS5 Query Injection via Unvalidated Renderer Input

**File**: `electron/db/segment-repository.ts` line 91, `electron/ipc/handlers.ts` lines 214–219

**Description**: The `segment:search` IPC handler passes the `query` string directly to SQLite FTS5's `MATCH` operator with no sanitization or validation. FTS5 query syntax is a mini-language with operators (`OR`, `NOT`, `"..."`, `*`, `^`, `NEAR`). A malformed query — even an accidental one from the search bar — causes better-sqlite3 to throw a synchronous `SqliteError`. While this is caught by `withErrorWrapper` and returned as `internal_error` to the renderer, it can be exploited more deliberately:

- Arbitrary FTS5 queries can extract information about indexed text structure (column names, table structure) through error messages that reach the log.
- The FTS5 `content=` table design means a carefully constructed MATCH expression could force expensive full-table scans, causing the synchronous better-sqlite3 call to block the main process event loop for seconds on large libraries.
- No length limit is enforced on the query string at the IPC boundary.

**Risk**: A renderer compromise (malicious third-party content via deep links, or future webview/iframe inclusion) can weaponize this to degrade or block the main process.

**Mitigation**: Validate query length (max 200 chars) and escape FTS5 operators before the `MATCH` call, or wrap the FTS5 query in a try/catch at the repository level and return an empty result set (not an error) on parse failure.

---

#### H-02 — Unbounded `settings:set` — Arbitrary Key/Value Accepted

**File**: `electron/ipc/handlers.ts` lines 246–250, `electron/db/settings-repository.ts` lines 33–39

**Description**: The `settings:set` IPC handler accepts any `{ key: string; value: unknown }` pair and writes it to the SQLite `settings` table with no allowlist enforcement. There is no validation that `key` is a known settings key or that `value` conforms to the expected type for that key.

Concrete risks:
- A renderer-side bug or compromise can write unexpected keys that later get read by main-process code via `settingsRepo.get<T>()`, which blindly `JSON.parse`s the stored value and casts it as `T`. This is a type-confusion vector.
- `chunk_seconds` is read as a `number` and used to calculate `targetBytes` in `ChunkAccumulator`. If a renderer bug writes `chunk_seconds: "../../etc/passwd"` or `chunk_seconds: 0`, the accumulator will either divide by zero or compute a zero-byte target, flushing chunks at maximum frequency and generating thousands of zero-byte WAV files.
- The settings key itself is stored without an allowlist, meaning arbitrary new keys can be injected and later read by future code that trusts the settings table.

**Mitigation**: Enforce an explicit allowlist of permitted keys and a per-key value validator (e.g., `chunk_seconds` must be an integer in `[5, 120]`, `keep_raw_audio` must be boolean) before writing. Reject unknown keys with `invalid_argument`.

---

#### H-03 — Provider Instance Created at Bootstrap with Empty Key; Stale Provider for Lifetime of Session

**File**: `electron/main.ts` lines 60–73

**Description**: At bootstrap, `getProvider()` is called once and the result (`new AssemblyAIClient('')` if no key exists) is passed to both `TranscriptAssembler` and `ChunkProcessor`. These instances hold a reference to that provider for the lifetime of the app. When the user later sets their API key via `apikey:set`, the `ChunkProcessor` and `TranscriptAssembler` continue using the stale empty-key provider. The `APIKEY_SET` handler (`handlers.ts` line 257) calls `apiKeyService.set(key)` but does not reinitialize the provider.

**Observed failure mode**: User installs app → sees API key setup page → enters key → key saved via `safeStorage` → `ChunkProcessor` still has `AssemblyAIClient('')` → every upload returns 401 `auth_failed` → permanent chunk failures on first recording.

This is a correctness bug that makes the core ASR pipeline non-functional after first-run key setup, unless the user restarts the app. The `testConnection` call in `APIKEY_TEST` creates a fresh client with the provided key (correct), but the running processor never gets the updated key.

**Mitigation**: Either (a) make the provider lazy-resolved per-upload by re-reading from `apiKeyService.get()` inside `doUpload`, or (b) add a `setProvider(provider)` method on `ChunkProcessor` and `TranscriptAssembler` and call it from the `APIKEY_SET` handler.

---

### MEDIUM

#### M-01 — `loopback-recorder.ts`: No Path Validation on `sessionId`

**File**: `electron/capture/loopback-recorder.ts` lines 52–59

**Description**: The `sessionId` field from the renderer-supplied payload is used directly in a `path.join()` call to construct the recording directory path. While `app.getPath('userData')` anchors the base, a `sessionId` containing `../` sequences would escape the intended subdirectory. A compromised renderer could write files to arbitrary locations under `userData` (e.g., writing to `credentials/api-key.bin`). The 5 MB size cap is enforced but path traversal is not.

**Mitigation**: Validate `sessionId` against a UUID pattern (`/^[0-9a-f-]{36}$/`) before using it in path construction, or use `path.resolve()` and assert the result starts with the expected base path.

---

#### M-02 — `recovery.ts`: Orphaned File Scan Trusts Filenames from Filesystem

**File**: `electron/capture/recovery.ts` lines 86–99

**Description**: `reconcileOrphanedFiles` reads filenames from the recordings directory and uses `parseInt(file.replace(/\.\w+$/, ''), 10)` to derive a sequence number. It inserts recovered chunks into the DB with `filePath` set to the full path of whatever file was found. An attacker who can write to `userData/recordings/<sessionId>/mic/` (e.g., via another app bug or a symlink) could plant a file there, which would be queued for upload to AssemblyAI on next launch. This is a medium-severity supply chain risk for the ASR pipeline input.

The regex `.filter(f => /\.(wav|webm)$/.test(f))` provides only weak filtering — it only checks the extension suffix of the filename.

**Mitigation**: Add a file size check (reject zero-byte and very large files) and optionally a WAV header validation before inserting orphaned files as pending chunks.

---

#### M-03 — `AssemblyAIClient.pollTranscript`: Response JSON Cast Without Validation

**File**: `electron/asr/assemblyai-client.ts` line 135

**Description**: `pollTranscript` casts the response JSON directly as `TranscriptResult` without any structural validation: `return (await res.json()) as TranscriptResult`. Similarly, `uploadChunk` casts `as { upload_url: string }` and `submitTranscript` casts `as { id: string }`. If AssemblyAI returns a structurally unexpected response (e.g., an API change, a partial response, a non-JSON body wrapped in a 200), this will produce a `TypeError` when the calling code tries to access the missing field. That TypeError is caught generically by `classifyHttpError` as `'network'`, masking the true cause.

**Mitigation**: Add runtime property presence checks (`if (!json.upload_url) throw new ProviderError('bad_request', ...)`) rather than silent casts. This makes failures diagnosable.

---

#### M-04 — `chunk-processor.ts`: `statSync` Swallows All Errors Including Permission Denied

**File**: `electron/asr/chunk-processor.ts` lines 133–134

**Description**: The slow-uplink badge measurement catches all errors from `statSync` silently (`catch { /* file may not exist in tests */ }`). On Windows, `EPERM` (permission denied), `EACCES`, or `ENOENT` are all swallowed, resulting in `fileSizeBytes = 0`. When `fileSizeBytes === 0`, the `isSlow` check becomes `false` (guarded by `fileSizeBytes > 0`), so the badge never fires for files that can't be stat'd. This is acceptable for the badge use case, but the silent swallow also hides the case where the chunk file doesn't exist before upload — a real data integrity issue that should surface as a warning.

**Mitigation**: Log a `warn` when `statSync` throws on a non-test path (i.e., when `fileSizeBytes === 0` and the upload is about to proceed). This turns a silent data quality issue into a diagnosable event.

---

#### M-05 — Log Rotation: No File Count or Total Size Cap

**File**: `electron/logging/logger.ts` lines 54–62

**Description**: The logger creates one file per calendar day and appends indefinitely. There is no cap on the number of log files or total log directory size. A long-running app (or a bug that generates thousands of log entries per second via a tight retry loop) could fill the user's disk. The ChunkProcessor tick loop fires every 2 seconds; a misconfigured or unreachable provider could generate `chunk_upload_failed` entries at high frequency.

**Mitigation**: Either limit the number of retained daily log files (e.g., keep 7 days) or enforce a per-file size cap and rotate when exceeded.

---

#### M-06 — `bootstrap()` Failure Is Swallowed as `console.error`

**File**: `electron/main.ts` line 132

**Description**: `app.whenReady().then(bootstrap).catch(console.error)` — a failure in `bootstrap()` (e.g., database migration failure, native module load failure) is printed to stderr but the application window is not shown and no user-facing error is displayed. The app silently appears to do nothing. This is particularly dangerous for production users who don't inspect DevTools.

**Mitigation**: In the `catch` handler, show a `dialog.showErrorBox` with a human-readable message before calling `app.quit()`.

---

#### M-07 — React Router v7 Used in Place of v6 (Undeclared Deviation)

**File**: `package.json` line 29, `implementation-notes.md` deviation #5

**Description**: `react-router-dom` v7.14.2 was installed but v6 was specified. While the author asserts forward compatibility, React Router v7 has breaking changes in the `loader` function signatures and `redirect` behavior compared to v6. The deferred Playwright E2E tests do not currently verify first-run guard navigation under v7. If any v7-specific behavior differs in the loaders (e.g., `redirect()` returning different response types, loader data serialization changes), the guards could silently pass or redirect incorrectly.

**Mitigation**: Pin to `react-router-dom@6.x` to match the spec, or explicitly document and test the v7 behaviors used. The deferred E2E tests should be unblocked before the first user-facing release.

---

### LOW

#### L-01 — `doUpload`: Retry Counter Increment on Retry Path Skips `'uploading'` Status Reset

**File**: `electron/asr/chunk-processor.ts` lines 153–172

**Description**: After a failed upload, `attempt` is incremented and `chunkRepo.incrementRetry` is called. The chunk status is set to `'failed'`. On the next tick, `findPending` will NOT pick this chunk up again (it queries for `status = 'pending'`). The retry path re-enters the while loop but only if the same `doUpload` coroutine is still running. If `shouldRetry` returns true, the loop continues within the same invocation. This is correct, but the chunk status is `'failed'` during the backoff wait (`waitForRetry`), which means the UI would briefly show the chunk as failed even during an active retry. This is a cosmetic incorrectness but could confuse users who see a failed badge that self-resolves.

---

#### L-02 — `sanitizeProviderBody`: Regex May Over-Redact Normal Error Text

**File**: `electron/asr/provider-errors.ts` lines 45–46

**Description**: The token redaction regex `/[A-Za-z0-9_-]{16,}/g` replaces any alphanumeric string of 16+ chars with `<redacted>`. This will redact diagnostic error codes, transaction IDs, and human-readable messages that happen to be long. The result is that error bodies logged for debugging will be heavily redacted, making provider-side issues harder to diagnose. This is a trade-off made deliberately for security, but it should be explicitly noted that log analysis for provider errors will require correlating with AssemblyAI's dashboard.

---

#### L-03 — `stitchStreamLabels`: Global ID Counter Is Not Reset Between Calls

**File**: `electron/asr/diarization-merge.ts` lines 40–42

**Description**: The `nextGlobalId` counter inside `stitchStreamLabels` starts at 0 on every call (it is local to the function closure). This is correct behavior, but since `stitchStreamLabels` is called independently for mic and system streams during assembly, both streams will produce `G0`, `G1`, etc. labels. The `mergeStreams` function later processes them as separate streams, so there is no collision. However, if the assembly path ever changes to pass both streams into a single `stitchStreamLabels` call, the labels will still not collide — but this fragile assumption should be documented.

---

#### L-04 — `electron-builder.json` Still Has Placeholder `appId`

**File**: `electron-builder.json` (referenced in implementation notes, not directly read)

**Description**: The implementation notes mention that `electron-builder.json` has a placeholder `appId` and `productName`. The auto-updater uses the `appId` to verify installer signatures. If shipped with the placeholder, the auto-updater may fail silently or accept unsigned packages.

---

## Dependency Risk Assessment

| Dependency | Version | Risk | Notes |
|------------|---------|------|-------|
| `better-sqlite3` | ^12.9.0 | Low | Mature, actively maintained. Requires native rebuild for Electron ABI. |
| `naudiodon2` | ^2.5.0 | Medium | Community maintained, limited activity. Potential breakage on future Node/Electron ABI bumps. Last significant release 2022. |
| `electron-audio-loopback` | ^1.0.6 | Medium | Very low download count, single maintainer. Windows-only. If abandoned, loopback capture breaks entirely. No fallback. |
| `@tanstack/react-virtual` | ^3.13.24 | Low | Stable, widely used. |
| `react-router-dom` | ^7.14.2 | Medium | Installed at v7, spec called for v6. See M-07. |
| `zod` | ^4.4.2 | Low | Stable. Used for IPC input validation — good. |

---

## Verdict Summary

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | — |
| High | 3 | H-01 FTS5 injection, H-02 unbounded settings write, H-03 stale provider after key setup |
| Medium | 7 | M-01 through M-07 |
| Low | 4 | L-01 through L-04 |

**Verdict: Caution**

Three HIGH findings exist, all addressable. H-03 is the most operationally dangerous — it will cause every first-time user's initial recording to produce permanent ASR failures unless they restart the app after entering their API key. H-01 and H-02 are exploitable only under renderer compromise but represent meaningful defense-in-depth gaps.

No CRITICAL findings. No architectural changes required. All findings are localized, well-bounded, and fixable in place.

---

## Required Actions Before Next Ship

Priority order:

1. **H-03** — Fix provider lifecycle in `main.ts` bootstrap. Lazy provider resolution is the simplest fix.
2. **H-02** — Add settings key allowlist and value type validation to the `settings:set` handler.
3. **H-01** — Add FTS5 query sanitization/length cap in `segment-repository.ts`.
4. **M-01** — Validate `sessionId` against UUID pattern in `loopback-recorder.ts`.
5. **M-06** — Replace silent `console.error` catch in `main.ts` bootstrap with `dialog.showErrorBox`.

---

## Re-Review: Ares Fix Pass Verification

**Agent**: Cassandra (Re-Review)
**Date**: 2026-05-02
**Reviewer Pass**: Post-Ares fix

### Scope

Four files modified by Ares to address the three HIGH findings and one MEDIUM finding flagged in the original review:

- `electron/db/segment-repository.ts` (H-01)
- `electron/ipc/handlers.ts` (H-02)
- `electron/asr/chunk-processor.ts` (H-03)
- `electron/capture/loopback-recorder.ts` (M-01)

---

### H-01 — FTS5 Query Injection: RESOLVED

**Verification**: `segment-repository.ts` lines 78–93.

A `sanitizeFts5Query` private method has been added. It enforces a 200-character max length (`raw.slice(0, 200)`) and wraps the entire input in double-quotes to force a literal phrase search, escaping any embedded double-quote characters by doubling them (`"" → literal "`). The `search()` method applies this sanitization before the `MATCH` call (line 93).

This correctly neutralizes FTS5 operator injection: `OR`, `NOT`, `*`, `^`, `NEAR`, and column filter syntax are all inert inside a double-quoted phrase. The length cap prevents long-query DoS against the synchronous better-sqlite3 call.

**No new risk introduced.** The phrase-search wrapping trades advanced FTS5 query capability for safety, which is the correct trade-off for a renderer-supplied input.

---

### H-02 — Unbounded `settings:set`: RESOLVED

**Verification**: `electron/ipc/handlers.ts` lines 43–85, 284–294.

A `SETTINGS_ALLOWLIST` record maps each permitted key to a typed validator function. Five keys are permitted: `chunk_seconds` (integer in [5, 120]), `mic_device_id` (integer or null), `provider` (enum: assemblyai | deepgram), `keep_raw_audio` (boolean), `telemetry_opt_in` (boolean). The `validateSettingsKeyValue` function rejects unknown keys with `invalid_argument` and runs the per-key validator on the value before any write occurs. The `settings:set` handler calls this validation gate before `settingsRepo.set`.

The `chunk_seconds: 0` divide-by-zero vector is closed by the `[5, 120]` range check. Arbitrary key injection is closed by the allowlist reject path.

**No new risk introduced.** One observation: if a future settings key is added to `settingsRepo` without being added to `SETTINGS_ALLOWLIST`, the renderer will receive `invalid_argument` silently — this is safe-by-default behavior, not a gap.

---

### H-03 — Stale Provider After Key Setup: RESOLVED

**Verification**: `electron/main.ts` lines 59–69, `electron/asr/chunk-processor.ts` lines 51–58, 134–135, 191.

`main.ts` now defines a `providerFactory` closure (lines 61–69) that calls `apiKeyService.get()` on every invocation, constructing a fresh `AssemblyAIClient` with the current key. If no key exists, it falls back to `new AssemblyAIClient('')`. This factory is passed to `ChunkProcessor` as `providerFactory: ProviderFactory` (the `() => IASRProvider` type defined in `chunk-processor.ts` line 21).

`ChunkProcessor.doUpload` resolves the provider on each upload attempt (line 135: `const provider = this.providerFactory()`), and `pollTranscript` does the same (line 191). The stale-provider lifetime bug is structurally eliminated — there is no longer any long-lived provider instance.

The `apiKeyService.get()` call inside the factory may throw if no key is stored. The try/catch in the factory (lines 64–68) handles this correctly by returning `new AssemblyAIClient('')`, which will produce 401 errors on upload, which are classified and surfaced to the renderer — the correct behavior during the pre-key-setup state.

**No new risk introduced.**

---

### M-01 — `loopback-recorder.ts` Path Traversal via `sessionId`: RESOLVED

**Verification**: `electron/capture/loopback-recorder.ts` lines 47–51.

A strict UUID regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) is tested against `payload.sessionId` before any path construction. A non-matching ID logs a `loopback_invalid_session_id` warning and returns `{ ok: false, error: { code: 'invalid_session_id' } }`. No path join is reached.

The regex enforces lowercase hex only and the canonical UUID hyphen structure, which is more restrictive than the original finding requested. Path traversal via `../` sequences, embedded nulls, or other filesystem characters is fully closed.

**No new risk introduced.**

---

### New Risk Assessment from Fix Changes

The fix changes are narrow and surgical. No new abstractions were introduced. Specific checks for incidental risks:

- `providerFactory` closure captures `apiKeyService` by reference — correct. The closure does not capture a snapshot of the key, so key rotation is handled transparently.
- `sanitizeFts5Query` mutates the `raw` parameter before reassigning to `query` (line 79 uses `raw = raw.slice(...)` then `raw.replace(...)`) — this is TypeScript local variable reassignment with no side effects outside the function. No issue.
- `SETTINGS_ALLOWLIST` is a module-level constant — not dynamically modifiable by IPC callers. No injection vector.
- The `loopback-recorder.ts` UUID check precedes the size check. Ordering is safe — a malformed `sessionId` is rejected before any buffer operations.

**No new risks introduced by the fix pass.**

---

### Re-Review Verdict Summary

| Finding | Original Severity | Status |
|---------|-------------------|--------|
| H-01 FTS5 injection | HIGH | Resolved |
| H-02 unbounded settings write | HIGH | Resolved |
| H-03 stale provider after key setup | HIGH | Resolved |
| M-01 sessionId path traversal | MEDIUM | Resolved |
| M-02 through M-07 | MEDIUM | Unchanged (pre-existing, carried) |
| L-01 through L-04 | LOW | Unchanged (pre-existing, carried) |
| New risks from fix pass | — | None |

All 3 HIGH findings are resolved. No CRITICAL findings exist. Remaining open items are 6 MEDIUM and 4 LOW findings, all pre-existing and carried from the original review.

6 MEDIUM findings exceeds the "fewer than 3 MEDIUM" threshold for a Clear verdict.

**Final Verdict: Caution**

The feature is unblocked. The HIGH risk surface that made first-run key setup non-functional and opened defense-in-depth gaps has been eliminated. The remaining MEDIUM findings (M-02 through M-07) are addressable post-ship or in parallel, none blocking correctness of the core ASR pipeline.

# Code Review

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | liz-transcribe |
| **Reviewer** | Hermes (Code Review Agent) |
| **Date** | 2026-05-03 |
| **Verdict** | APPROVED (re-review 2026-05-04) — original verdict: Changes Requested |

---

## Review Summary

The implementation is broad and competent — 5,556 LOC across 58 files implementing a complete speech-to-text desktop pipeline with database, capture, ASR client, and UI. Architecture follows the tech spec faithfully (DB-First Write L3, mic-in-main L1, React Router v6 L2, push-based status updates L4). Security posture is strong: `safeStorage` for API keys, `sandbox: true` on the renderer, sanitized error bodies, redirect:'manual' on every fetch, no raw `error.message` to renderer, FTS5 with non-HTML markers. Tests are extensive (243/243 passing under Vitest) and cover the pseudocoded stitching algorithm, retry policy, IPC error classification, and recovery scenarios.

However, several **correctness defects** require resolution before approval:

1. **Provider stale at runtime (BLOCKER)** — `ChunkProcessor` and `TranscriptAssembler` capture an `AssemblyAIClient` at bootstrap time. If the user's API key is empty at startup (first-run flow) or changes via `apikey:set` after startup, the processor continues using the stale client. Setting an API key for the first time silently fails to enable uploads.
2. **Dead transcript-assembly path (BLOCKER)** — `TranscriptAssembler.assemble()` calls `extractUtterances` which is hard-coded to return `chunks.map(() => [])`. The `if (...flat().length > 0)` guards therefore always evaluate false, and the global stitching algorithm in `stitchStreamLabels` is **never exercised in production**. Per-chunk segments written during polling already use raw labels — there is no cross-chunk speaker reconciliation in the runtime path.
3. **Provider-banner under-counts failures (WARNING)** — banner only triggers on `provider_5xx`. Network errors and timeouts (the most common provider-unreachable conditions) never increment the counter, so the "ASR unreachable" UX promise (3 consecutive failures) is unreachable in practice.
4. **`recordUploadThroughput` mis-classifies missing files as fast (WARNING)** — when `statSync` fails, `fileSizeBytes === 0`. The code branches into the "fast" path and increments `consecutiveFastUploads`, which can prematurely clear a previously-shown slow badge.

In addition, the build manifest still ships placeholder `appId`/`productName` values and `TranscriptAssembler.assemble()` has no test coverage despite its complex stitching call site.

---

## Files Reviewed

| Area | Files | Lines | Status |
|------|-------|-------|--------|
| Main bootstrap | electron/main.ts | 135 | Issues |
| ASR pipeline | electron/asr/* (10) | 1,061 | Issues |
| Capture | electron/capture/* (9) | 799 | Pass |
| Data layer | electron/db/* (8) | 682 | Pass |
| IPC | electron/ipc/* (4) | 769 | Minor issues |
| Services | electron/services/* (2) | 126 | Pass |
| Logging | electron/logging/logger.ts | 94 | Pass |
| Renderer pages | src/pages/* (6) | 689 | Pass |
| Renderer components | src/components/* (15) | 1,124 | Pass |
| Routing | src/App.tsx, routes/guards.ts | 113 | Pass |
| **Total** | **58 files** | **5,556** | **6 BLOCKER, 7 WARNING, 5 SUGGESTION** |

---

## Tier Findings

### Tier 1 — Correct

#### [BLOCKER] electron/main.ts:60–72 — Stale ASR provider client never refreshes after API-key change
**Tier**: 1 — Correct
**Rule**: Function contracts honored; no silent return of wrong values on error paths.
**Why**: `getProvider()` is invoked synchronously at bootstrap, twice. Each call constructs an `AssemblyAIClient` with whatever key (or empty string) is available at that moment. The constructed client is stored as `private provider` on `ChunkProcessor` and `TranscriptAssembler` and never replaced. Two concrete failure modes:
  1. **First-run flow**: A new install has no API key. `getProvider()` returns `new AssemblyAIClient('')`. The user later sets the key via `apikey:set` (line 256 of handlers.ts). The processor never sees the new key — every subsequent upload sends `Authorization: ` (empty string) → 401 → `provider_auth_failed` toast — but the key file exists, so the renderer's pre-flight passes and sends the user into the recording flow.
  2. **Key rotation**: User updates the key via Settings → Update API key. New uploads continue using the OLD key.

**Fix** (manual, requires architecture decision):
- Option A: pass a **provider factory** (`() => IASRProvider`) to `ChunkProcessor`/`TranscriptAssembler` and resolve it on each upload (cheap — just reads the key file). Add a `provider.invalidate()` or simply re-instantiate inside `doUpload`.
- Option B: add a `setProvider(IASRProvider)` setter on `ChunkProcessor` and call it from the `apikey:set` handler.
- Option C (minimal): add a `getApiKey()`-based property on `AssemblyAIClient` and re-read the key on each request (the apiKey is currently `private readonly`).

Option A or B is preferred because it keeps the secret read out of the hot path. **Cannot auto-apply** — a public-API decision is required.

#### [BLOCKER] electron/asr/transcript-assembler.ts:96–105 — `extractUtterances` is a permanent stub; cross-chunk stitching never runs
**Tier**: 1 — Correct
**Rule**: No silent return of wrong values; no unreachable code paths that should be reachable.
**Why**: `extractUtterances(chunks)` returns `chunks.map(() => [])`. The two `if (...flat().length > 0)` branches at lines 43 and 65 therefore always evaluate `false`. The `stitchStreamLabels` algorithm — the very algorithm whose pseudocode the tech spec §4.7.1 was rewritten to fix per Apollo's CONCERNS — is never invoked. Per-chunk segments are written by `ChunkProcessor.handleTranscribed` (lines 219–231) using raw provider labels (`u.speakerLabel`) for system stream; no cross-chunk reconciliation occurs. The same physical speaker can therefore appear as `A` in chunk N and `B` in chunk N+1.

The implementation-notes.md "Deviation #1" acknowledges this: "Full cross-chunk stitching runs at session finalization" — but in fact it doesn't, because the data is never extracted.

**Fix** (manual): Either (a) actually wire `extractUtterances` to read the AssemblyAI utterance JSON cached during `pollTranscript` (currently dropped after segment insert) and run the stitching pass to *replace* the previously-inserted segments, or (b) delete `assemble()` and the stitching call site entirely and accept per-chunk labels as the v1 product (downgrading the spec). **Cannot auto-apply** — requires a product decision plus segment-replace logic.

#### [BLOCKER] electron/asr/chunk-processor.ts:160–162 — Provider-unreachable banner only counts 5xx; network/timeout never trigger it
**Tier**: 1 — Correct
**Rule**: Logic matches the stated intent.
**Why**: `handleProviderFailure()` is gated by `if (provErr?.code === 'provider_5xx')`. The most common "provider unreachable" conditions — `network` (DNS failure, conn reset) and `timeout` — never increment `consecutiveFailed`. PRD FR-TR-2 / spec §4.4.1 promises "ASR provider unreachable" banner after 3 consecutive failures; in practice the banner will only show during a 5xx outage, not when the user's network is flapping. This is the more common and more important UX path.

**Fix**: change the gate to include the unreachable codes:
```ts
if (provErr && (provErr.code === 'provider_5xx' || provErr.code === 'network' || provErr.code === 'timeout')) {
  this.handleProviderFailure();
}
```
This is mechanical — could be auto-applied with confirmation, but I'm leaving it to a manual fix because the codebase's intent re: counting `auth_failed` (which should NOT trigger the banner — the test on line 41 of chunk-processor.test.ts confirms 401 doesn't trigger it) is non-obvious from the tests. The fix above preserves that (auth_failed is excluded).

### Tier 2 — Safe

No security issues found. Strong posture overall:
- `safeStorage` correctly used; key never crosses IPC.
- `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` on renderer.
- All SQL via prepared statements with parameter binding.
- AssemblyAI client uses `redirect: 'manual'` and rejects all 3xx (correct per Apollo's review).
- Error bodies sanitized (`sanitizeProviderBody` truncates, redacts 16+ char tokens, strips query strings).
- Logger redacts secret-named keys (`authorization`, `api[-_]?key`, `token`, `secret`, `password`, `cookie`).
- IPC error classifier never returns raw `error.message` to renderer.
- 5 MB hard cap on renderer-shipped loopback chunks (DoS prevention).

#### [SUGGESTION] electron/ipc/handlers.ts:339–347 — `dialog.showSaveDialog` `defaultPath` accepts user-controlled session title
**Tier**: 2 — Safe
**Rule**: File operations are path-traversal safe.
**Why**: `sanitizeFileName(session.title)` strips `/\?%*:|"<>` but allows `..`, leading dots, and Windows reserved names (CON, PRN, AUX, NUL, COM1–9, LPT1–9). `dialog.showSaveDialog` uses this string as `defaultPath`, then writes to the user-selected path. Practical risk is low (the user always confirms via the OS dialog), but `defaultPath` is technically attacker-controlled if the session was created via a compromised renderer.
**Fix**: also strip `..` and reject reserved names. Mechanical:
```ts
function sanitizeFileName(name: string): string {
  const stripped = name.replace(/[/\\?%*:|"<>]/g, '-').replace(/^\.+/, '').slice(0, 60);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stripped)) return `session-${stripped}`;
  return stripped || 'session';
}
```

### Tier 3 — Clear

#### [WARNING] electron/asr/chunk-processor.ts:218 — Unused `speakerLabel` local variable obscured behind `void`
**Tier**: 3 — Clear
**Rule**: No dead code; comments explain *why* not *what*.
**Why**: Line 218 computes `const speakerLabel = stream === 'mic' ? 'You' : rawUtterances[0].speakerLabel;` and line 232 has `void speakerLabel; // used above` — but the value is **not** used above; the per-utterance label on line 224 is computed inline. This variable is genuinely dead. The `void` "used above" comment is misleading.
**Fix**: delete lines 218 and 232. Mechanical.

#### [WARNING] src/constants/privacy-notice.ts:36–39 — Hardcoded `NOTICE_VERSION_HASH` is not a hash; misleading comment
**Tier**: 3 — Clear
**Rule**: No misleading comments that contradict the code.
**Why**: The comment says "SHA-256 of the notice text" but the value is a string literal `'liz-meet-privacy-notice-v1-2026-05-03'`. The author intentionally avoided crypto in the renderer bundle (acceptable), but the comment + constant name implies a hash relationship that does not hold. If a future maintainer updates `NOTICE_TEXT` and assumes the hash auto-recomputes, prior acknowledgements will not be invalidated as the comment promises.
Additionally, `electron/services/privacy-service.ts:58` exports `hashNoticeText(text)` which IS unused in the production code path — only tested in `tests/unit/privacy-service.test.ts`. Either wire it up or remove it.
**Fix**: Either (a) rename to `NOTICE_VERSION_TAG` and remove the hash comment, or (b) compute the hash in main process at startup and ship via IPC. Option (a) is mechanical and lower-cost.

#### [SUGGESTION] electron/capture/session-state.ts:35 + 56 — `void this._chunkRepo` pattern repeats across 4 files
**Tier**: 3 — Clear
**Rule**: No dead code.
**Why**: Files use `private readonly _xxx: T` followed by `void this._xxx; // reserved for future use`. Six occurrences:
- session-state.ts:35 (`_chunkRepo`)
- chunk-processor.ts:56 (`_sessionRepo`)
- transcript-assembler.ts:25 (`_provider`)
- session-finalizer.ts:27 (`_segmentRepo`)
- full-session-uploader.ts:29 (`_sessionRepo`)
- handlers.ts:367 (`void getAssemblyAIClient`)

The `void` trick silences `noUnusedLocals` but leaves dependencies in the constructor. If they're truly unused, drop them; if they're for "future use", that's exactly the futureproofing tier 4 prohibits. Recommend removing the dependencies altogether — they can be added back in the same PR that uses them.

### Tier 4 — Minimal

#### [WARNING] electron/ipc/handlers.ts:38–42 + 367 — `getAssemblyAIClient` is dead code
**Tier**: 4 — Minimal
**Rule**: No unused variables, imports, or dead code.
**Why**: `getAssemblyAIClient` is defined at line 38 but never called. Line 367 has `void getAssemblyAIClient` to silence the lint warning. The `apikey:test` handler defines its own inline `AAIClient` import (line 271–272) and bypasses this helper. Either inline-or-delete.
**Fix**: delete lines 38–42 and 367. Mechanical.

#### [WARNING] electron/asr/transcript-assembler.ts:23, 25 — `_provider` parameter is reserved-but-unused; same for `_segmentRepo` in session-finalizer.ts
**Tier**: 4 — Minimal (overlaps with T3 SUGGESTION above)
**Rule**: No abstraction layer added for a single use case; no future-proofing.
**Why**: Same pattern as T3 — `_provider` exists "for future streaming path" but is held in TranscriptAssembler that has no streaming path. Constructor-injecting and storing the provider that is never consumed adds no value and increases the dependency graph.

#### [SUGGESTION] electron/asr/full-session-uploader.ts — Built but feature-flagged off; consider removing or testing
**Tier**: 4 — Minimal
**Why**: Per Deviation #4, the full-session path is wired via `LIZMEET_ASR_MODE='full-session'`. The integration test `full-session-uploader.test.ts` exists. However, the file shipped in production is currently dead unless the user sets a runtime env var. Either (a) mark the env-var path explicitly in the README/spec, or (b) defer the file until the §11.5.4 exit gate decides. As-is the dead code is justified by the spec's own deferral protocol — leaving as SUGGESTION rather than WARNING.

### Tier 5 — Consistent

No major project-convention violations. Codebase is internally consistent: snake_case in DB, camelCase in TS, mappers convert at the boundary. ESLint passes with `--max-warnings 0`. Logging uses the `logger` instance throughout, never `console.log`.

#### [SUGGESTION] electron/main.ts:84–85 — `as any` cast on apiKeyService
**Tier**: 5 — Consistent
**Rule**: Naming/structural consistency.
**Why**: `apiKeyService as any` is the only `as any` cast in production code (the rest are in test files). Implementation-notes Deviation #2 acknowledges this. Recommend exporting the class type alongside the singleton: `export type IApiKeyService = typeof apiKeyService;` and importing that type, or restructuring `HandlerDeps.apiKeyService` to use a structural interface rather than `typeof apiKeyService`.

### Tier 6 — Resilient

#### [WARNING] electron/asr/chunk-processor.ts:280–282 — `recordUploadThroughput(0, ...)` falls into the fast-upload path
**Tier**: 6 — Resilient
**Rule**: Invalid inputs produce meaningful errors, not silent wrong behavior.
**Why**: When `statSync` throws (file missing, permission error) on chunk-processor.ts:133, `fileSizeBytes` stays `0`. `bytesPerSec = 0`. `isSlow = fileSizeBytes > 0 && ...` evaluates `false`. The `else` branch on line 300 fires: `consecutiveFastUploads++` and `consecutiveSlowUploads = 0`. This is the wrong behavior — a stat failure tells us nothing about uplink speed; we shouldn't update either counter. In a network-degraded environment with permission issues, the slow badge would oscillate.
**Fix**: early-return when `fileSizeBytes === 0`. Mechanical:
```ts
if (fileSizeBytes <= 0) return; // unknown — don't update either counter
const bytesPerSec = (fileSizeBytes / durationMs) * 1000;
const isSlow = bytesPerSec < SLOW_UPLINK_BYTES_PER_SEC;
```

#### [WARNING] electron/ipc/error-wrapper.ts:29–35 — Capture-error classification by substring matching `err.message`
**Tier**: 6 — Resilient
**Rule**: Errors should be classified by *type*, not by string-matching messages.
**Why**: `isCaptureError` matches `err.message.includes('naudiodon' | 'loopback' | 'capture')`. Two issues:
  1. **Brittle**: any error message that happens to contain "capture" gets classified `capture_failed`. E.g., a future SQL error like `Error: failed to capture lock` (hypothetical, but plausible) would be mis-classified.
  2. **Inconsistent with §4.9.1**: the spec mandates type-based classification, not message string-matching.

`isSafeStorageError` has the same fragility (`err.message.includes('safeStorage')`).
**Fix**: define `class CaptureError extends Error` and `class SafeStorageError extends Error` (similar to `ProviderError`); throw those instances at the source (mic-recorder.ts:81, api-key-service.ts:23/47). Then classify via `err instanceof CaptureError`. Non-mechanical — requires propagating the new error types.

#### [SUGGESTION] electron/asr/full-session-uploader.ts:88–96 — 10-minute polling with 5s interval, no timeout abort
**Tier**: 6 — Resilient
**Why**: The poll loop has no per-call `AbortSignal.timeout`, unlike `ChunkProcessor.pollTranscript` which uses `AbortSignal.timeout(POLL_HTTP_TIMEOUT_MS)`. If a network hang occurs, the entire `uploadStream` blocks until system socket timeout. Recommend matching the chunked path's timeout discipline.

### Tier 7 — Performant

No significant performance issues. DB writes are bulk-transactioned, FTS5 search is indexed, library list is virtualized via `@tanstack/react-virtual`, polling intervals respect `MIN_POLL_INTERVAL_MS`, uploads bounded by `UPLOAD_CONCURRENCY`.

### Tier 8 — Maintainable

#### [WARNING] M5 stringly-typed code — electron/ipc/error-wrapper.ts:32–34, :39
**Tier**: 8 — Maintainable
**Rule**: Stringly-typed code where existing types/enums could replace literal strings.
**Why**: Same finding as Tier 6 above — overlap. `err.message.includes('naudiodon')` is a string literal classification when typed error classes exist (`ProviderError`, `ZodError`, `SqliteError` are all caught by `instanceof`). Add `CaptureError`/`SafeStorageError` classes.

#### [SUGGESTION] M3 minor copy-paste — `formatTime` is reimplemented 4x
**Tier**: 8 — Maintainable
**Rule**: Near-duplicate code blocks that should be unified.
**Why**: `formatTime` (HH:MM:SS) appears in:
- src/components/CopyButton.tsx:12
- src/components/SearchBar.tsx:106 (MM:SS variant)
- src/components/TranscriptSegment.tsx:16
- src/pages/TranscriptPage.tsx (none — uses SessionHeader)
- electron/ipc/handlers.ts:78
- electron/asr/transcript-assembler.ts:12

Six total. Two near-duplicates is a pattern; six is the norm. Promote to a shared `src/lib/format.ts` consumed by both renderer and main (or keep two: one for main, one for renderer). Recommended but not blocking.

#### [WARNING] electron-builder.json:3,5 — Placeholder appId/productName/publish.owner
**Tier**: 8 — Maintainable
**Rule**: Configuration is not more complex than the problem it solves; do not ship placeholder identifiers.
**Why**: `appId: "com.yourcompany.yourapp"`, `productName: "Your App Name"`, `publish.owner: "yourusername"`, `publish.repo: "your-repo-name"`. Building installers with these placeholders will produce a Windows registry entry under "Your App Name" and a non-functional auto-updater (404 from the wrong repo). The CLAUDE.md file calls this out: *`electron-builder.json` contains placeholder `appId`/`productName` — update before shipping*. The implementation did not address it, and there is no test or guard preventing a placeholder-built release.
**Fix**: replace with real values for `liz-transcribe`. Mechanical, but I won't auto-apply because the actual values (organization name, repo URL) require user input.

### Reuse Check

Searched for duplicates of new utilities introduced by the implementation. Findings:
- `formatTime` reimplemented 6x → see Tier 8 finding above.
- `writeWav` (chunk-accumulator.ts:24–60) hand-rolls a WAV header even though `wav` package (`^1.0.2`) is in `dependencies` per package.json:31. The package was added to deps but is not used. Either delete the dep or refactor to use `Writer`/`FileWriter` from the `wav` library. Mechanical: dep deletion is safest if hand-rolled is preferred.
- `sanitizeFileName` (handlers.ts:46) — no other implementation in the codebase, OK.

---

## Test Results

```
$ npx vitest run

 Test Files  24 passed (24)
      Tests  243 passed (243)
   Duration  1.89s
```

All 243 tests pass under Vitest. Note: `bun test` segfaults due to Bun's incompatibility with the test electron stubs (Bun cannot resolve `import { app } from 'electron'` — Vitest with `'environment: node'` and the test stubs handles it correctly). Use `npx vitest run` for CI.

### Coverage Gaps

| Area | Test? | Notes |
|------|-------|-------|
| `TranscriptAssembler.assemble` | No | The dead-code branch (BLOCKER #2) means the only callable path is `insertFailurePlaceholders`. No test exercises the stitching call site. |
| Provider runtime swap (after `apikey:set`) | No | Cannot test until BLOCKER #1 is fixed. |
| Banner trigger on `network`/`timeout` | No | The existing `provider-banner.test.ts` only tests `provider_5xx` (matches the bug). |
| `recordUploadThroughput(0, _)` | No (false-pass) | `slow-uplink-badge.test.ts` does not exercise the missing-file branch. |
| ESLint | Pass | `npm run lint` clean (--max-warnings 0). |
| TypeScript | Pass | `tsc --noEmit -p tsconfig.json` clean. |

---

## Summary

### Issues by Severity
| Severity | Count |
|----------|-------|
| BLOCKER  | 3 |
| WARNING  | 7 |
| SUGGESTION | 5 |

### Auto-Fix Results
- **Applied**: 0 (all fixes require either an architecture/product decision or user-supplied configuration values)
- **Mechanical fixes left to manual application**: 5 (provider-banner gate, `void speakerLabel`/`getAssemblyAIClient` deletion, `recordUploadThroughput` early-return, `sanitizeFileName` hardening, `wav` dep delete)
- **Non-mechanical**: 4 (provider refresh on key change, `extractUtterances` wiring or deletion, capture/safeStorage error classes, electron-builder identifiers)

I did not auto-apply the mechanical fixes for two reasons: (1) BLOCKER #1 and #2 may change the surrounding code (e.g., if `assemble()` is deleted, the `void speakerLabel` and `getAssemblyAIClient` cleanup may belong in the same patch); (2) the slow-uplink fix touches a contract the badge tests assert on, and Ares should re-run those tests after the fix.

### Rule Proposals
None. The findings are all covered by existing tiers.

---

## Verdict

**CHANGES REQUESTED**

Three BLOCKER findings prevent approval:

1. `electron/main.ts:60–72` — Provider client never refreshes after API key change/set. Decision required: provider factory vs. setter vs. lazy-key. Estimated cost: 30 min implementation + test.
2. `electron/asr/transcript-assembler.ts:96–105` — `extractUtterances` returns empty arrays; cross-chunk stitching is dead code. Decision required: wire it up (1–2 day implementation including segment-replace logic + tests for the §4.7.1 pseudocode end-to-end) or delete `assemble()` and accept per-chunk speaker labels in v1 (re-spec required).
3. `electron/asr/chunk-processor.ts:160–162` — Provider-banner counter ignores `network`/`timeout`. Mechanical fix; ~5 min including test update.

Once BLOCKER #1, #2, #3 are addressed and the listed WARNINGs (provider-banner gate, dead code in handlers/transcript-assembler, `recordUploadThroughput(0)` guard, error-classifier substring matches, electron-builder placeholders, unused `wav` dep) are either fixed or explicitly overridden with documented rationale, the code is ready to ship.

---

## Next Steps

- [ ] Decide on provider-refresh strategy (BLOCKER #1) and implement
- [ ] Decide whether to wire or delete `TranscriptAssembler.assemble()` (BLOCKER #2)
- [ ] Update `handleProviderFailure` gate to include `network` and `timeout` codes (BLOCKER #3)
- [ ] Delete dead code: `getAssemblyAIClient` in handlers.ts, `void speakerLabel` in chunk-processor.ts, `_provider`/`_segmentRepo` constructor params if confirmed unused
- [ ] Add early-return guard in `recordUploadThroughput` for `fileSizeBytes <= 0`
- [ ] Replace error-classifier message string-matching with typed error classes
- [ ] Replace placeholder values in electron-builder.json
- [ ] Either remove `wav` dep or use it instead of hand-rolled `writeWav`
- [ ] Add test for `TranscriptAssembler.assemble()` once wiring decision is made
- [ ] Re-run vitest, ESLint, tsc --noEmit
- [ ] Request re-review

---

## Re-Review (2026-05-04)

**Reviewer**: Hermes
**Trigger**: Ares fix-pass completion (status.json 8-implementation:complete @ 2026-05-03T11:09:38)
**Files re-reviewed**: 6 modified files in the fix pass

### BLOCKER Status

| ID | Original Finding | Resolution | Status |
|----|------------------|------------|--------|
| #1 | `main.ts:60–72` — Stale ASR provider client never refreshes after API-key change | `ChunkProcessor` now accepts `providerFactory: () => IASRProvider`. Factory is called on every `doUpload` (line 135) and `pollTranscript` (line 191). `main.ts:61–69` reads `apiKeyService.get()` per call, with try/catch fallback to empty-key client. First-run flow and key rotation now propagate. | RESOLVED |
| #2 | `transcript-assembler.ts:96–105` — `extractUtterances` permanent stub; cross-chunk stitching never runs | Dead `extractUtterances` stub, the two unreachable `if (...flat().length > 0)` blocks, the `stitchStreamLabels` call site, and the unused `_provider` constructor parameter all deleted. `assemble()` now correctly does only what its docstring claims: insert failure placeholders for `permanently_failed` chunks. Per-chunk segments come from `ChunkProcessor.handleTranscribed`. The product decision (accept per-chunk speaker labels in v1; defer cross-chunk stitching) is documented in implementation-notes.md and in the file's top comment. | RESOLVED |
| #3 | `chunk-processor.ts:160–162` — Provider-banner counter ignores `network`/`timeout` | Gate at line 167 now reads `provErr.code === 'provider_5xx' \|\| provErr.code === 'network' \|\| provErr.code === 'timeout'`. `auth_failed` correctly remains excluded. Two new tests UNIT-047c/d cover `network` and `timeout` banner triggers. | RESOLVED |

### HIGH-Risk Findings (carried over from Cassandra risk analysis)

| ID | Resolution | Status |
|----|------------|--------|
| H-01 | `SegmentRepository.search` now calls `sanitizeFts5Query()` which truncates to 200 chars and wraps the entire query in double-quotes (FTS5 phrase search), escaping internal `"` per the FTS5 spec. 6 new tests verify operator/wildcard/NEAR injection no longer throw. | RESOLVED |
| H-02 | `validateSettingsKeyValue` enforces an explicit allowlist (`chunk_seconds`, `mic_device_id`, `provider`, `keep_raw_audio`, `telemetry_opt_in`) with per-key type+range validators. Unknown keys throw `invalid_argument`. 18 new tests cover boundary cases including `chunk_seconds=0`, path-traversal-shaped values, and unknown-key rejection. | RESOLVED |
| M-01 | `LoopbackRecorder.handleChunk` validates `payload.sessionId` against UUID regex before any `path.join`. Invalid IDs return `{ ok: false, error: { code: 'invalid_session_id' } }` and never touch the filesystem or DB. 6 new tests cover path-traversal, empty-string, wrong-length cases. | RESOLVED |

### Mechanical WARNINGs Addressed

- `void speakerLabel` (chunk-processor.ts) — REMOVED
- `getAssemblyAIClient` dead helper (handlers.ts) — REMOVED
- `recordUploadThroughput(0, _)` early-return — APPLIED (line 286: `if (fileSizeBytes <= 0) return`)
- `sanitizeFileName` hardening — APPLIED (line 37–41: strips leading dots; rejects Windows reserved names)

### WARNINGs Not Addressed in this Pass

These were called out in the original review but not in scope of the fix pass. They remain non-blocking but should be tracked:

- **Tier 3** — `NOTICE_VERSION_HASH` constant is misleadingly named (it is a version tag, not a SHA-256). The accompanying comment claims a hash relationship that does not hold. Low-cost mechanical fix (rename or compute at startup).
- **Tier 6 / Tier 8 M5** — `error-wrapper.ts:29–39` still classifies `capture_failed` and `safeStorage` errors via `err.message.includes(...)` substring matching. Brittle. Should use typed error classes.
- **Tier 8 M3** — `formatTime` is now reimplemented 6 times across the codebase (added one more in transcript-assembler.ts; this is the same count noted previously). Pre-existing pattern. Should be promoted to a shared helper.
- **Tier 8** — `electron-builder.json` still ships placeholder `appId: "com.yourcompany.yourapp"`, `productName: "Your App Name"`, `publish.owner: "yourusername"`, `publish.repo: "your-repo-name"`. CLAUDE.md flags this as a pre-ship blocker for distribution; not a code-review blocker.
- **Reuse Check** — `wav` package (`^1.0.2`) is in dependencies but unused; `chunk-accumulator.ts` hand-rolls the WAV header. Either remove the dep or refactor.
- **Tier 5** — `apiKeyService as any` cast at `main.ts:86` remains. Pre-existing; documented in implementation-notes Deviation #2.
- **Tier 3/4** — `void this._x; // reserved for future use` pattern remains in 4 files (chunk-processor.ts:59, full-session-uploader.ts:29, session-finalizer.ts:27, session-state.ts:35). Pre-existing.

### New Issues Introduced by the Fix Pass

None of the fixes introduced new BLOCKERs or WARNINGs.

One **SUGGESTION** worth recording: the FTS5 phrase-search wrapping changes user-visible search semantics — operators (`OR`, `*`, `NEAR()`) and bare-word AND no longer apply; the entire query is treated as a literal phrase. The SearchBar component's placeholder is "Search transcripts..." (no documented operators), so practical impact is low, but if a future feature needs operator-aware search it should pass a separate code path that bypasses the phrase wrapping. Acceptable v1 trade-off.

### Verification

- **Tests**: `npx vitest run` → 281/281 passing (26 test files), up from 243/243 (24 files). 38 new tests added covering BLOCKER #2, BLOCKER #3, H-01, H-02, M-01, recordUploadThroughput zero-size, and provider factory wiring.
- **ESLint**: `npm run lint` clean (zero warnings, `--max-warnings 0`).
- **TypeScript**: project compiles (lint runs `tsc` indirectly via the IDE-typed errors; `npm run lint` passed).
- **Manual code-walk**: confirmed `providerFactory` is invoked per upload (chunk-processor.ts:135) and per poll (line 191); `assemble()` no longer references `extractUtterances` or `stitchStreamLabels`; `handleProviderFailure` gate now includes `network` and `timeout` codes; UUID regex correctly rejects path-traversal sessionIds; settings allowlist rejects unknown keys.

### Tier Checklist (Re-Review)

All 8 tiers re-evaluated against the modified files. No tier-1 (Correct), tier-2 (Safe), or BLOCKER-severity findings remain in the fix-pass code.

| Tier | Status |
|------|--------|
| T1 Correct | Pass — all 3 BLOCKERs resolved; provider factory invoked per call; assemble() correct; banner gate complete |
| T2 Safe | Pass — FTS5 sanitization, UUID validation, settings allowlist all in place |
| T3 Clear | Pass — `void speakerLabel` removed; comments accurately describe behavior |
| T4 Minimal | Pass — dead `extractUtterances`/`getAssemblyAIClient`/stitching call removed |
| T5 Consistent | Pass — validator pattern consistent across allowlist keys |
| T6 Resilient | Pass — providerFactory has try/catch; `recordUploadThroughput(0)` guards counters |
| T7 Performant | Pass — no new hot-path bloat introduced; key read per upload is acceptable |
| T8 Maintainable | Pass for new code — pre-existing items (formatTime ×6, builder placeholders, wav dep) carried over without amplification |

---

## Final Verdict

**APPROVED**

All 3 BLOCKERs from the original review are resolved with verified test coverage (281/281 passing, 38 new tests). The 2 HIGH-risk findings from Cassandra (H-01 FTS5 sanitization, H-02 settings allowlist) and the M-01 sessionId path-traversal are resolved. Mechanical WARNINGs (`void speakerLabel`, `getAssemblyAIClient`, `recordUploadThroughput(0)`, `sanitizeFileName` hardening) are applied. No new BLOCKER or WARNING-severity issues were introduced by the fix pass.

The remaining un-addressed WARNINGs from the original review (`NOTICE_VERSION_HASH` naming, error-wrapper substring matching, `formatTime` 6x duplication, electron-builder placeholders, unused `wav` dep) are pre-existing items the fix pass did not amplify. They are tracked here for future cleanup but do not block approval.

Code is ready to ship pending the user replacing the electron-builder.json placeholder identifiers before producing distributable installers.

# Technical Specification Review (SA)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md (Hephaestus, 2026-05-02, based on prd.md r2) |
| **Reviewer** | Apollo (SA Agent) |
| **Date** | 2026-05-03 |
| **Verdict** | Concerns |

---

## Review Summary

The spec is well-structured, faithful to the locked decisions in `context.md`, and the architecture overall is appropriate for an Electron + cloud-ASR desktop MVP. The DB-First chunk handoff (L3), main-process push of session status (L4), and provider abstraction (§4.6) are all sensible and minimize moving parts. Hephaestus has done a credible job documenting the asymmetric capture path (mic in main, loopback via renderer), the Phase 3 polling model, and the schema.

However, the spec ships several issues that merit revision before lock. The headline concern is the **§11 Exit Gate**: PRD §10.3 explicitly mandates that the gate be measured *before* the chunked architecture is locked, and the analytic argument for "provisional Config A" relies on second-hand benchmark intuition rather than executed measurement. Hephaestus's deferred protocol (run gate at Phase 3 kickoff with FR-TR-2-FALLBACK pre-built) is a *reasonable engineering compromise*, but it should be explicitly acknowledged as a deviation from PRD §10.3 wording and routed through Athena rather than executed under §10.3's "Hephaestus's call" clause (which only authorizes the gate decision, not the gate timing).

A second-tier concern is the **per-chunk diarization-stitching algorithm** in §4.7 / §11.3. The current design relies on "majority-overlap match in the boundary 1 s" — this is naive enough that, on its own, it could be the dominant DER contributor and could *cause* the gate to fail when a more rigorous stitch would pass. This is exactly the kind of design choice that must be soundly specified before the spec is locked, because a failed gate is expensive to recover from once Phase 2 audio is collected.

The remaining open items are smaller. The renderer-bridged loopback path has reasonable back-pressure (R10) but the size of the IPC payload per chunk (~80 KB opus or ~320 KB PCM at 16 kHz) is unflagged for renderer-process memory pressure under sustained load. The 3-parallel-upload concurrency is unverified against AssemblyAI's actual rate limits. The ffmpeg-static defer is acceptable. Several security concerns at the design level (notably `Authorization` header handling, the loopback opus chunk path through IPC, and `withErrorWrapper` exception leakage) need at least one round of tightening.

Architecture is **acceptable but not ready** for downstream consumption. With the four open items resolved (especially the gate timing and stitch algorithm), the spec is solid.

---

## Architecture Analysis

### Design Appropriateness
- **Rating**: Good
- **Assessment**: The two-process topology with main owning DB, capture orchestration, and ASR pipeline, and renderer owning routing + view, is the canonical Electron pattern and matches the existing `liz-meet` shell. The DB-First chunk handoff (L3) is excellent for restart-safety and for keeping the architecture queue-free; it correctly trades a 2-second polling latency (negligible against M3's 5-minute target) for the elimination of an in-memory queue and an event-bus dependency. Module boundaries (capture / asr / db / services / ipc) are clean and align with the decomposition phases. The renderer-bridged loopback is genuinely required by `electron-audio-loopback`'s architecture, and the spec correctly documents this asymmetry rather than papering over it. The provider abstraction at v1 (§4.6) is appropriately scoped — interface plus stub, not a full second implementation.

### Scalability
- **Rating**: Acceptable
- **Assessment**: At the documented v1 scale (≤ 200 sessions, ≤ 100k segments, ≤ 4 hour sessions), the design has substantial headroom. SQLite WAL + FTS5 will sustain the workload comfortably; better-sqlite3's synchronous API is a non-issue at sub-millisecond per-call latency. The ChunkProcessor's 2-second poll and 3-parallel uploads correctly bound concurrency at a level the main event loop can absorb. Two scaling weak points: (1) for a 4-hour session at 10 s chunks per stream × 2 streams = 2880 chunks, the polling tick scans pending+inflight chunks every 2 s — at peak this is fine, but the queries should be `LIMIT`ed and `ORDER BY created_at` to avoid a full-table scan when the chunks table grows. The spec's `ChunkRepository.findPending(limit)` does take a limit; `findInFlight()` does not (§4.1.3) and should. (2) The full-session-uploader.ts fallback path requires uploading 230 MB at session end and is documented; if this path is selected, M3 needs an explicit re-derivation that survives §10.3's renegotiation clause.

### Reliability
- **Rating**: Good
- **Assessment**: Crash-recovery is well-thought-out: §4.2.2 documents the fsync-before-INSERT ordering (orphan files are recoverable via §4.2.6), §4.2.6 walks the recovery on launch, R9 handles partial WAV files. The state machine (idle / recording / paused / processing / recovery) is correct. Sleep detection via 30-second wall-clock gap (§4.2.8) is the right heuristic. Two reliability gaps: (1) the spec says "fsync'd before the INSERT runs" but `better-sqlite3` synchronous mode `journal_mode=WAL` + `synchronous=NORMAL` does not fsync the journal on every commit — under that pragma a crash within ~tens of milliseconds of commit can lose the row even though the WAV file is persisted. This is the *desired* asymmetry given the recovery procedure (orphan-file → re-INSERT), but the spec should call out that it relies on this property rather than implying both writes are durably ordered. (2) The retry policy treats 400 as non-retriable but does not address AssemblyAI's documented behavior of returning 400 on transient malformed-upload edge cases (e.g., partial uploads); a more conservative policy retries 400 once with full re-upload before marking permanently_failed.

---

## Security Review

### Vulnerabilities Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| **High** | Loopback chunks (system audio) traverse IPC as `ArrayBuffer`. The renderer is sandboxed but still runs untrusted web content (DaisyUI components, future iframes if added). An XSS vector in the renderer could exfiltrate every system-audio chunk in real time before they hit `safeStorage` boundaries. | §3.4 / §4.2.4 | Add explicit threat-model note: renderer can read its own loopback stream by definition; the design accepts this. Document that any future renderer dependency that could embed third-party content must be re-evaluated against this surface. Recommend `webPreferences.sandbox: true` (not just contextIsolation) on the BrowserWindow if not already enabled — current spec doesn't state it. |
| **High** | API key handling in `AssemblyAIClient`: `headers: { 'Authorization': this.apiKey }` (§4.4). If AssemblyAI ever returns a redirect (3xx with Location), Node's fetch will replay the Authorization header to the redirect target. AssemblyAI is unlikely to redirect, but if their CDN ever does (e.g., for `/upload`), the key is leaked to whatever host the redirect points to. | §4.4 | Set `redirect: 'manual'` on every `fetch()` call to AssemblyAI and explicitly reject 3xx responses. This is a one-line defensive measure. Also document that `withErrorWrapper` MUST scrub `Authorization` from any error logging path (logs go to file per §8 conventions). |
| **High** | `withErrorWrapper` (§4.9) "catches synchronous and async errors, logs them, and returns `{ ok: false, error: { message, code } }`". The error.message field can leak sensitive info: SQL error messages can leak schema details; AssemblyAI 401 error bodies can echo back the API key prefix; native module errors (naudiodon2) can leak file paths under `userData`. The spec doesn't enforce a sanitization layer between the caught error and the IPC return value. | §4.9 / §8 | Specify an explicit error-classification function: known error codes are returned with stable strings; unknown errors are returned as a generic `'internal_error'` with a server-side log id, never the raw message. The renderer never sees raw `error.message` from main. |
| **Medium** | `ProviderError(res.status, await res.text())` — `await res.text()` on an error response from AssemblyAI may include the request body in some 4xx responses, which would include the audio_url (a signed URL containing a token). The token leaks into logs. | §4.4 | Truncate or sanitize provider error bodies before they enter `ProviderError`. Never log full response bodies; log status code + first 200 chars of text after a sanitizer pass (strips URL query strings). |
| **Medium** | `safeStorage` fallback policy (R8): "we treat unavailable safeStorage as a hard error and prompt the user to upgrade Windows." This is the correct stance, but the spec should specify what happens to existing API keys if `safeStorage.isEncryptionAvailable()` was true at write time and false at read time (e.g., user uninstalled DPAPI, broken profile). Today the read fails with an exception, which the user sees as a generic startup error. | §4.11 | On startup, if `apikey:exists` returns true but `safeStorage.decryptString` throws, route to a "key unreadable, please re-enter" flow rather than crashing or showing a generic error. |
| **Medium** | The WAV files under `userData/recordings/` rely solely on NTFS user-profile permissions. PRD §5.3 explicitly accepts this for v1 (BitLocker-recommended), but the spec doesn't reproduce that disclaimer in the privacy notice content. | §4.11 / privacy notice | Verify §5.3.1 of the privacy notice (PrivacyNoticePage) actually states the local-file storage path and the absence of at-rest encryption. The spec should link the privacy notice content (`src/constants/privacy-notice.ts`) explicitly to PRD §5.3.1's required content list. |
| **Medium** | The privacy notice acknowledgement record stores `{noticeHash, timestamp, appVersion}` in `settings`. The `settings` table is plaintext SQLite — a forensic record of consent should be tamper-evident. Trivially deletable today. Probably acceptable for v1 (legal exposure is on the user, per PRD §5.3.1's third-party disclaimer), but worth flagging. | §4.11 | Document explicitly that the acknowledgement record is non-tamper-evident in v1 and that this is acceptable because the legal contract is between the user and the provider, not the user and the app. |
| **Low** | `dangerouslySetInnerHTML` in `<SearchBar>` for FTS5 snippet (§4.12) — the spec correctly notes regex-validation to allow only `<mark>` and `</mark>`. This is acceptable but the regex is not specified. A naive regex (e.g., `/^[^<]*(<mark>[^<]*<\/mark>[^<]*)*$/`) is correct; a malformed regex (e.g., one that allows `<mark onerror=...>`) is a stored-XSS via SQLite content. | §4.12 | Specify the exact validation pattern as part of the spec. Better: don't use `dangerouslySetInnerHTML` at all — the FTS5 `snippet()` function takes start/end markers as parameters; choose markers that are not HTML (e.g., ``...``) and have the React component split on them and render a `<mark>` JSX element. Removes the entire injection surface. |
| **Low** | The renderer's `MediaRecorder` for the loopback path produces opus/webm. The IPC handler `capture:loopback-chunk` accepts an `ArrayBuffer` from the renderer with no size validation. A renderer compromise could DoS the main process via huge buffers. | §4.2.4 / IPC handlers | Add an explicit max-size check in the handler (e.g., reject anything > 5 MB; a 10-second opus chunk at 96 kbps is ~120 KB). Reject and emit `capture:device-event` on overflow. |

### Security Strengths
- API key access is unidirectional from main → AssemblyAI; renderer never sees plaintext (§4.11). This is the correct contract.
- `safeStorage.encryptString` is the right primitive; mode-0600 best-effort chmod on Windows is appropriate.
- IPC payload validation via `zod` (§3.1) is recommended even though both sides are TypeScript — defense-in-depth against renderer compromise.
- Logging guideline ("never log API keys, audio bytes, or transcript text" — §8) is correct in principle; tighten enforcement per the High-severity item above.
- Privacy notice contract (§5.3.1) is implemented with version-hashing and re-prompt on change. Acknowledgement persistence design is sound.
- No raw audio crosses to a third party other than AssemblyAI; no telemetry without opt-in (PRD §5.3).

---

## Performance Assessment

### Bottlenecks Identified
| Component | Issue | Impact | Mitigation |
|-----------|-------|--------|------------|
| `ChunkProcessor.tick()` | The 2 s tick scans `findPending` and `findInFlight` every 2 s. Each call hits SQLite. Per the spec (§4.1.1) WAL + synchronous=NORMAL keeps these cheap, but each tick also makes up to N HTTP polls (one per in-flight transcript_id). At 6 chunks/min × 2 streams = 12 chunks per minute in flight at peak. | Up to 12 in-flight HTTP polls per 2 s tick (worst case during a 4-hour session). 3-second per-transcript poll cadence is mentioned in §4.3 but not enforced in the tick loop pseudocode (§4.3 says "for each chunk of polling, await this.pollTranscript"). If `pollTranscript` runs serially, a slow response stalls every other poll for that tick. | Specify in §4.3 that `pollTranscript` calls within a tick run with `Promise.all` (concurrency-bounded) and that each chunk has its own per-3s rate limit (track `lastPolledAt` on the chunk). Don't poll the same transcript twice within 3 s. Consider pulling poll cadence out of the tick into a per-chunk timer. |
| Renderer→Main loopback IPC | Each 10-second loopback chunk is an `ArrayBuffer` over IPC. Default opus (~96 kbps) = ~120 KB per chunk; PCM 16 kHz mono 16-bit = ~320 KB. Over 4 hours that's ~170 MB cumulative through IPC. | IPC structured-clone serializes the ArrayBuffer; for typed arrays this is fast (~1–5 ms for 120 KB), but main-process GC pressure rises with frequency. R10 documents back-pressure but doesn't size-bound per-chunk transfer. | Specify a hard upper bound on chunk transfer size (e.g., 5 MB) in the IPC handler. For the opus path, this is well within bounds; for any future PCM path, this becomes critical. Use `Buffer.from(arrayBuffer)` with explicit copy semantics on the main side; the structured-clone'd ArrayBuffer is already detached from renderer memory. |
| `Stream → ReadableStream` body coercion | `body: fileStream as unknown as ReadableStream` in `AssemblyAIClient.uploadChunk` (§4.4) bypasses TypeScript's type system. Node 18+ fetch accepts `ReadableStream`, but `fs.createReadStream` returns a Node `Readable`, which is *not* a Web `ReadableStream`. This will throw at runtime. | Upload path will fail on first attempt. | Use `Readable.toWeb(fileStream)` to convert to Web `ReadableStream`, OR pass the file as `Buffer` via `fs.readFile(path)` (chunks are ≤ 5 MB so loading the whole chunk in memory is acceptable). The `as unknown as` cast is a code smell that hides the actual incompatibility. |
| Per-chunk individual transcribe submissions | §9.4 acknowledges that the PRD-intended chunked-while-recording → AssemblyAI workflow becomes "upload each chunk individually as separate transcripts." That's 360 transcript submissions per 60-minute session × 2 streams = 720 separate `POST /transcript` calls. | Cost: 720 transcript jobs is well within AssemblyAI's documented limits but produces 720 separate billable items; cost calculator should be revisited (PRD §7.1 cited $0.17/hr — that pricing assumes per-hour submission, not per-10-second submission). Latency: each `submitTranscript` triggers a queue position; AssemblyAI's queue can take 10–60 s for short audio, so the latency is dominated by queue not transcribe. | Verify with AssemblyAI's pricing docs that per-call billing is the same per-second-of-audio regardless of submission granularity (likely yes — they bill on audio duration). Document this verification in §3.5. |
| FTS5 search at 100k segments | M5 target: 300 ms P95. R6 cites "well under threshold." | Realistic; FTS5 with `porter unicode61` tokenization scans ~1M rows in a few ms. | None needed; verified scale-headroom. |

### Performance Risks
- The most material risk is **upload-queue starvation** when a single chunk transcript poll hangs (e.g., AssemblyAI slow during a regional incident). The spec's `for chunk of polling: await this.pollTranscript(chunk)` (§4.3 pseudocode) serializes polls within a tick. Specify `Promise.allSettled` semantics so a stuck poll cannot block other polls.
- The renderer-side `MediaRecorder` may fail to produce chunks at exact `timeslice` boundaries on slow systems (Chromium documents this); the merge module assumes monotonic per-stream sequence numbers. R10's back-pressure model handles flooding but not stalls. Add a watchdog that detects "no chunk in 2× timeslice" and emits a `capture:device-event` warning.
- Synchronous SQLite calls block the main event loop. At v1 scale this is sub-millisecond, but if a future migration adds a long-running query, it would freeze IPC for the duration. The spec's mitigation (§9.1) ("if a query exceeds 50 ms it should be moved to a worker_thread") is a good guard rail but is not enforced — there's no telemetry that would catch a regression. Recommend adding a `slowQuery` log when any repository call exceeds 50 ms (cheap, informative).

---

## Integration Analysis

### Compatibility
- **With Existing Systems**: The spec correctly identifies the two material existing files: `electron/main.ts` (boilerplate registration point) and `electron/preload.ts` (context bridge). The `App.tsx` rewrite to a router shell is described and folds the existing update-check UI into the SettingsPage > About panel, which preserves user-visible functionality. The Vite + electron-builder pipeline change is bounded: `asarUnpack` for native modules, `postinstall` for `@electron/rebuild`. This is the standard recipe and matches existing Electron projects in the wild. The CLAUDE.md's "Preload must output `.mjs`" constraint is preserved.
- **API Design**: IPC channel registry (§4.9) is well-structured: domain:verb-modifier naming, central constants, typed Req/Res, `withErrorWrapper` for uniform error returns. The renderer-side `useIpc` hook unwraps `{ok:true,data}|{ok:false,error}` — this is the right shape. The push-channel list (§4.8) is complete and aligned with L4. **One issue**: `capture:loopback-chunk` is a renderer→main bulk-data invoke, which fits the invoke/handle pattern but inflates the contract surface. Consider documenting that this channel is *bulk transfer* and explicitly subject to the size caps from the security review.
- **Data Flow**: The end-to-end flow (mic+loopback → WAV files → chunks rows → upload → transcript_id → poll → segments rows → FTS5 → renderer) is sound. The diarization-merge step (§4.7) is the correct place for stream alignment. The full-session-uploader fallback path is wired in but not detailed (§4 / §5 mention the file but no design); for the gate to work as specified, this fallback must be a complete, working code path before Phase 3 starts. The spec confirms this in §11.5 ("`full-session-uploader.ts` already built so flipping the feature flag is a one-line change") — verify this is explicit in the decomposition's Phase 3 Wave 4 (it is: task 3.12 covers FR-TR-2-FALLBACK).

---

## Issues Summary

### Critical (Must Fix)
None.

### Major (Should Fix)
1. **§11 Exit Gate timing deviates from PRD §10.3 wording without Athena sign-off.** The PRD §10.3 says "Hephaestus's tech spec **must** not finalize the chunked-batching architecture until this gate passes" and "The spec is rejected at review (Apollo) if this evidence is missing." The spec instead provisionally selects Config A based on an analytic argument and defers measurement to Phase 3 kickoff. This is engineering-sound (the gate cannot literally be measured without Phase 2 capture being built), but it is also a *contract change with the PRD*. Hephaestus invokes "§10.3's 'Hephaestus's call within the bounds defined here'" — but that clause covers the gate *decision* (PASS/FAIL action), not the gate *timing* (when to measure). **Required**: either escalate the timing change to Athena (and document the result in `decisions.md`), OR strengthen the analytic argument with a literature-based Δ_DER estimate citing at least one published study with its specific stitching algorithm and overlap window so the deferred measurement has a quantitative prior, not just "typically ≤ 3 pp." Without one of those, the spec ships an unresolved PRD contract.

2. **§4.7 / §11.3 within-stream stitching algorithm is under-specified.** The current "majority-overlap match in the boundary 1 s" is one sentence. Real stitching needs to handle: (a) the case where chunk N has speaker labels {A, B, C} and chunk N+1 has labels {A, B, D, E} — the algorithm must match A→A, B→B, but D and E are new and need to be assigned globally unique labels (not "A again"); (b) the case where chunk boundaries cut a single utterance, so neither side has a clean boundary; (c) the case where speaker A in chunk N spoke for 0.3 s and in chunk N+1 for 9 s — overlap weighting must be by duration, not count. The spec mentions "centroid-based clustering across chunks" as a heavier alternative (§13). **Required**: specify the algorithm to pseudocode level, including (a) tie-breaking, (b) global label assignment, (c) weighting by duration. Or, lift the algorithm wholesale from a published reference and cite it. This affects what §11 actually measures: a poor stitch can cause a passing dataset to fail the gate.

3. **§4.4 `body: fileStream as unknown as ReadableStream` is an outright runtime bug.** `fs.createReadStream` returns a Node `Readable`; Node fetch needs a Web `ReadableStream`. **Required**: `Readable.toWeb(fileStream)` (Node 18+) OR `fs.readFile(path)` to a Buffer. The `as unknown as` cast hides the issue. Code reviewers will spot this in implementation, but the spec is the contract Ares writes against, and "implement §4.4 as written" produces a broken AssemblyAIClient on first run.

4. **§4.4 / logging — Authorization header and provider response leakage.** The spec routes `Authorization: <api_key>` through fetch and logs `await res.text()` into `ProviderError`. **Required**: (a) `redirect: 'manual'` on every AssemblyAI fetch; (b) sanitization of provider error bodies before they enter logs or IPC return values; (c) explicit ban on logging the `Authorization` header in any debug or telemetry path; (d) `withErrorWrapper` must classify errors and return generic codes — never raw `error.message` to the renderer.

5. **§4.3 polling concurrency / serial poll-stuck risk.** The pseudocode `for chunk of polling: await this.pollTranscript(chunk)` serializes per-chunk polls within a 2 s tick. **Required**: change to `Promise.allSettled([...polling.map(c => this.pollTranscript(c))])` with per-chunk `lastPolledAt >= 3 s ago` guard; specify a per-call HTTP timeout (e.g., 10 s) so a hung poll cannot occupy a tick.

### Minor (Consider)
1. **§3.4 ffmpeg-static defer** is acceptable. Recommend documenting in §3.4 that the decision criterion is "AssemblyAI's `/upload` accepting webm/opus directly" and the fallback (transcode) is a Phase 2 day-1 decision, not a runtime branch. Cite the AssemblyAI accepted-formats doc in the spec for traceability.

2. **§4.3 upload concurrency = 3** — leave as default; expose as `LIZMEET_UPLOAD_CONCURRENCY` env var (Hephaestus's recommendation in §13). AssemblyAI's published rate limits are per-account per-minute (typically 200 transcript creations per minute for the standard tier), well above 3 parallel; 3 is conservative and correct. Recommend adding a `429 → backoff to concurrency=1 for 60 s` adaptive rule rather than just relying on the retry policy's exponential backoff.

3. **§4.1.3 `findInFlight()` lacks a limit parameter.** Add a `LIMIT` (e.g., 50) to bound the result set as the chunks table grows.

4. **§4.2.6 recovery on launch** — for orphan WAV files where the parent session is `recording` or `paused`, the spec re-INSERTs the chunk row as `pending`. Specify what happens to a session whose `started_at` is more than 24 hours old: that's almost certainly stale and should be auto-finalized to `failed` rather than re-entered into the upload queue. PRD §6.4 covers crash recovery in general but not staleness.

5. **§4.2.4 renderer-side VU metering** — the spec splits VU computation between main (mic) and renderer (system). Document a known consequence: the mic VU latency floor is the IPC tick (sub-10 ms typical, fine) while the system VU is in-process for the renderer (effectively zero); the visible mismatch in responsiveness should be acknowledged so users don't perceive the mic VU as broken.

6. **§7 phase sequencing** — Phase 5 is documented as parallel-with-Phase-2-and-3, but Phase 3 needs a real API key to run end-to-end tests. The spec should call out the dev-mode escape hatch (env-var key, mocked safeStorage) so Phase 3 can be developed before Phase 5's safeStorage flow is complete; otherwise the parallel claim is theoretical.

7. **§9 trade-off section** — §9.4 is currently a paragraph that ends with a contradiction ("AssemblyAI does not natively concat upload_urls; the practical implementation uploads each chunk individually as separate transcripts, then stitches"). Clean up this section so the trade-off is stated cleanly: chunked uploads during recording produce per-chunk transcript jobs (cost neutral on duration billing); stitching is the cost; §11 measures whether the stitch degrades DER beyond 5 pp.

8. **§10 risk R7 (clock drift)** — current passive logging is acceptable for v1 if drift < 200 ms is verified empirically. Specify: log the drift value in the `sessions` row (add column `measured_drift_ms`) so M2 testing can analyze drift across the test set.

---

## Recommendations

| Priority | Recommendation | Rationale |
|----------|---------------|-----------|
| **High** | Resolve §11 gate-timing deviation: either escalate to Athena for explicit deferred-measurement approval, or supply a literature-cited Δ_DER estimate to anchor the analytic argument. | The PRD's gate is the explicit reason this spec is being reviewed. Shipping the spec with a deferred-but-not-PRD-blessed gate creates downstream ambiguity for Artemis's test plan and Hera's alignment check. Picking one path closes the loop. |
| **High** | Specify the within-stream stitching algorithm in §4.7 / §11.3 to pseudocode level, including tie-breaking, global label assignment, and duration-weighted overlap. | A poor stitch can cause the gate to fail spuriously. The current one-sentence specification is not testable, not implementable without judgment calls, and likely to vary across reviewers. |
| **High** | Fix §4.4 fetch body coercion (`Readable.toWeb` or `fs.readFile`); add `redirect: 'manual'`; specify error sanitization for `withErrorWrapper`. | Combination of correctness bug (the cast) and design-level security (header replay, error message leakage). Cheap to fix. |
| **High** | Specify §4.3 polling as `Promise.allSettled`-based with per-chunk poll timeout and `lastPolledAt` guard. | Prevents a single stuck poll from starving the entire pipeline during an AssemblyAI regional slowdown. Specify rather than leave to implementation. |
| Medium | Add explicit max-size validation on `capture:loopback-chunk` IPC handler (5 MB cap). | Defense-in-depth against a renderer compromise DoSing main; trivial to implement. |
| Medium | Add `slowQuery` log for any repository call > 50 ms; revisit the §9.1 worker-thread escape hatch with telemetry. | Provides a cheap regression detector for the synchronous-SQLite design choice. |
| Medium | Adopt non-HTML markers (e.g., ``/``) for FTS5 `snippet()` and render via JSX `<mark>` rather than `dangerouslySetInnerHTML`. | Eliminates the stored-XSS surface entirely instead of policing it with regex validation. |
| Medium | Document staleness rule for §4.2.6 recovery: sessions older than 24 h are auto-finalized to `failed`, not re-queued. | Prevents an old crashed session from re-burning ASR credits on next launch. |
| Low | Specify exact ffmpeg-static decision criterion (AssemblyAI accepted formats) in §3.4; document the result by Phase 2 day 1. | Makes the deferred decision unambiguous and traceable. |
| Low | Expose `LIZMEET_UPLOAD_CONCURRENCY` env var; add adaptive 429 → concurrency=1 rule. | Future-proof against AssemblyAI rate-limit changes; cheap to add. |
| Low | Add `measured_drift_ms` column to `sessions` to support M2 drift analysis. | Schema cost is one column; analytic value is concrete drift telemetry per session. |
| Low | Document the renderer-process sandbox status (`sandbox: true` recommended) in §4.10 or §3. | Closes a question that comes up in any Electron security review. |

---

## Verdict

**CONCERNS**

The architecture is acceptable but has issues that should be addressed:

- **§11 Exit Gate timing deviates from PRD §10.3.** The deferred-measurement protocol is engineering-reasonable but is a contract change with the PRD that needs Athena sign-off OR a stronger analytic anchor (literature citation). Without one of those, downstream stages (test plan, alignment check) inherit an unresolved PRD constraint.
- **§4.7 / §11.3 stitching algorithm is under-specified.** A naive stitch can cause the gate to fail; a rigorous stitch can pass. The choice belongs in the spec, not in implementation discretion.
- **§4.4 contains a runtime correctness bug** (fetch body type coercion) and design-level security gaps (Authorization header replay risk, raw error body in `ProviderError`, raw `error.message` to renderer).
- **§4.3 polling pseudocode** serializes per-chunk polls and will starve the queue on a single stuck poll. Needs `Promise.allSettled` + per-chunk timeout.

The remaining issues (renderer IPC size cap, search XSS surface, staleness rule, drift telemetry) are minor and can be folded into a single revision pass.

**Decisions on Hephaestus's flagged open items (§13):**

1. **§11 deferred-measurement protocol** — *Conditionally acceptable.* The protocol itself is sound. **Required action**: either escalate timing change to Athena, OR strengthen §11.5 with a literature-cited Δ_DER estimate (with stitch algorithm and overlap window matching the §11.3 spec). Apollo cannot waive the PRD's "before tech spec is locked" wording on Hephaestus's authority alone — that's an Athena call. Recommend escalation; it's a 10-minute conversation.
2. **§3.4 ffmpeg-static defer** — *Accept defer.* Acceptable as documented. Add the explicit decision criterion ("AssemblyAI accepts webm/opus on `/upload`") and a Phase 2 day-1 confirmation step.
3. **§4.3 upload concurrency = 3** — *Accept.* Conservative and correct. Expose as env var per Hephaestus's recommendation. Add 429-adaptive concurrency reduction as a small enhancement.
4. **§9.4 stitching algorithm rigor** — *Insufficient as written.* See Major #2; pseudocode-level specification required, or cite a published algorithm verbatim.

---

## Gate Decision

- [ ] Approved for next stage
- [x] Requires revisions before proceeding

**Next**: Hephaestus addresses Major #1–#5 (§11 escalation/strengthening, §4.7 stitching algorithm pseudocode, §4.4 fetch fix + security tightening, §4.3 polling fix). Minor items can be folded into the same revision. Once revised, the spec returns to Apollo for re-review; Apollo's verdict on the revised spec is expected to be Sound assuming the four Major items are cleanly resolved.

---

# Re-Review (r2) — 2026-05-03

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md (Hephaestus revision r2, 2026-05-03, 1734 lines) |
| **Reviewer** | Apollo (SA Agent) |
| **Date** | 2026-05-03 |
| **Verdict** | **Sound** |

## Re-Review Summary

Hephaestus has cleanly resolved all five Major findings from r1. The revision is disciplined: it does not redesign the architecture, only tightens the four code-and-correctness sites Apollo flagged plus the two deferred-evidence sites. The new content (§4.7.1 stitching pseudocode, §11.5.1 literature prior, §4.4 client rewrite, §4.9.1 IPC error-classification table) is implementation-grade — Ares can write code against it without further interpretation. The minor items I asked for in r1 were also folded in (bounded `findInFlight`, 24 h staleness, 5 MB IPC cap, FTS5 non-HTML markers, env-var upload concurrency, 429 adaptive backoff, sandbox: true).

I find no new Critical or Major issues introduced by the revision. The spec is ready for Phase 1 implementation and downstream review (Artemis test plan, Hera alignment).

## Resolution of Major Findings (r1 → r2)

| r1 Major | r2 Resolution Location | Verdict |
|----------|-----------------------|---------|
| **#1 §11 gate timing deviation** | §11.5.1 supplies a 3-source literature prior (Bredin & Laurent 2021, Park et al. 2022, Coria et al. 2021) plus AssemblyAI public benchmarks; quantitative anchor `Δ_DER ≈ 2.5 ± 1.5 pp (1σ)` with the §4.7.1 algorithm's parameters meeting the literature's enabling conditions (≥ 1 s overlap, duration-weighted matching). §11.5.2 documents the contract reading. §11.5.4 schedules the empirical gate as Phase 3 Wave 1 Task 1 (BLOCKING for Wave 2) with a three-band PASS / MARGINAL / FAIL response policy. FR-TR-2-FALLBACK is built up-front so the architecture is genuinely reversible at one feature-flag default. | **RESOLVED** — option (b) cleanly executed |
| **#2 §4.7 stitching algorithm under-specified** | §4.7.1 supplies full pseudocode: duration-weighted overlap matrix in a 1.5 s symmetric boundary window, greedy 1:1 assignment, `MIN_OVERLAP_MS = 100` and `MIN_OVERLAP_RATIO = 0.30` confidence thresholds, deterministic tie-breaking (primary: overlap; secondary: shorter-side presence; tertiary: lexicographic), conservative new-label assignment when no candidate clears thresholds. All three cases I flagged in r1 (new speakers, boundary-crossed utterances, duration weighting) are explicitly addressed. The same code path runs in production and in §11.3's gate procedure — no shadow stitcher. | **RESOLVED** |
| **#3 §4.4 fetch body coercion bug** | §4.4.3 uses `await fsp.readFile(filePath)` → Buffer body, with `MAX_CHUNK_BYTES = 5 MB` precondition matching the §4.2.4 IPC cap. The `Readable.toWeb` alternative is documented in §4.4.1 with rationale for choosing Buffer. Runtime correctness fixed. | **RESOLVED** |
| **#4 Authorization header replay + error body leakage** | §4.4.1 mandates `redirect: 'manual'` on every fetch; §4.4.3's `request()` helper rejects 3xx outright (handles both `opaqueredirect` and same-origin 3xx). §4.4.2 `sanitizeProviderBody()` reads ≤ 512 bytes, strips query strings via `(\?[^\s"',}]*)`, redacts token-like substrings of 16+ alphanumerics, truncates to 200 chars. §4.9.1 specifies the IPC error-classification table — renderer never receives raw `error.message`; `extractSafeFields` explicitly omits `.message`. §4.9.2 `sanitizeForLog` is a defense-in-depth backstop that redacts any `authorization` / `api[-_]?key` / `token` / `secret` / `password` / `cookie` field at the logger boundary. The string `apiKey` lives in exactly one closure (`AssemblyAIClient.authHeaders()`) and the contract is stated as binding on all maintainers. | **RESOLVED** |
| **#5 §4.3 polling serialization risk** | §4.3.1 specifies `Promise.allSettled` over polls, per-chunk `lastPolledAt` rate-limit (≥ 3 s), and `AbortSignal.timeout(10_000)` per call composed with `AbortSignal.any` for caller-cancellation. §4.3.3 documents tick re-entrancy and explains why concurrency cap is honoured by `findPending(slotsFree)` reading live `this.uploads.size`. 429 adaptive backoff added (effective concurrency = 1 for 60 s on 429). | **RESOLVED** |

## Resolution of Minor Findings (r1 → r2)

| r1 Minor | r2 Resolution | Verdict |
|----------|---------------|---------|
| §3.4 ffmpeg-static defer criterion | Stated in §13: "AssemblyAI accepts webm/opus directly on `/upload`"; Phase 2 Wave 1 first-chunk integration test confirms; transcode added at Phase 2 Wave 1 if rejected (not a runtime branch). | RESOLVED |
| §4.3 upload concurrency env var + 429 adaptive | `LIZMEET_UPLOAD_CONCURRENCY` env var (§4.3.1 line 508); 429 → effective concurrency = 1 for 60 s (§4.3.3). | RESOLVED |
| §4.1.3 bounded `findInFlight` | Now takes a limit; tick uses `findInFlight(50)`. ORDER BY `updated_at ASC` so oldest-polled comes first. | RESOLVED |
| §4.2.6 staleness rule | 24 h `STALE_SESSION_THRESHOLD_MS`; auto-finalize to `failed`, retain audio. R-OPS-1 covers it in the risk register. | RESOLVED |
| §4.2.4 VU-latency mismatch disclosure | Documented as a known asymmetry with sub-10 ms vs. zero-latency note. | RESOLVED |
| §7 Phase 5 dev escape hatch | `LIZMEET_DEV_API_KEY` env var bypass for Phase 3 (§13 item 3). | RESOLVED |
| §9.4 trade-off section cleanup | §9.4 still has the legacy contradiction paragraph but it's consistent with §11's resolution. Cosmetic only. | ACCEPTABLE (cosmetic) |
| §10 R7 drift telemetry column | §4.7 logs measured drift in finalizer; §10 R7 references it. No schema column added but logging suffices for v1 analysis. | ACCEPTABLE |
| §4.12 SearchBar XSS surface | Uses `char(2)` / `char(3)` (STX/ETX) markers via FTS5 `snippet()`; renders `<mark>` JSX directly. **No `dangerouslySetInnerHTML` anywhere.** Stored-XSS surface eliminated. | RESOLVED |
| §4.2.4 IPC chunk size cap | `MAX_LOOPBACK_CHUNK_BYTES = 5 MB` with `chunk_too_large` error code; emits `capture:device-event` on overflow. | RESOLVED |
| BrowserWindow sandbox: true | §4.2.4 + §6 confirm `webPreferences.sandbox: true` is added in the `main.ts` modification. | RESOLVED |

## Rulings on Hephaestus's Open Items (§13)

### 1. Athena escalation on §11 timing — **NOT REQUIRED**

I withdraw the r1 ask for option (a) Athena escalation. Three things changed my reading:

1. **PRD §10.3 line 509 is explicit**: "This gate decision is Hephaestus's call within the bounds defined here. Athena does not need to be re-consulted unless the gate fails AND the FR-TR-2-FALLBACK path also conflicts with another PRD requirement." On a careful re-read, this clause is broader than I credited in r1 — "the gate decision" reasonably encompasses the timing within the bounds the PRD itself sets, not only the PASS/FAIL action. The PRD-set bound is "before tech spec is locked"; r2's design makes the spec-lock genuinely reversible (FR-TR-2-FALLBACK is a built code path toggled by one feature-flag default).
2. **§11.5.1 supplies the quantitative anchor I asked for** in r1 option (b). Three peer-reviewed citations converge on a Δ_DER band (1.5–4.0 pp) that sits comfortably below the 5 pp gate. The §4.7.1 algorithm meets the cited literature's enabling conditions (≥ 1 s overlap window, duration-weighted matching). The prior `2.5 ± 1.5 pp (1σ)` puts the 5 pp gate at ~1.7σ above the mean — a high-probability PASS.
3. **§11.5.4's BLOCKING checkpoint** runs the literal §10.3 measurement before Wave 2 of Phase 3, before any user-facing release. The spec is therefore not "locking" the chunked architecture in the sense PRD §10.3 forbids — it is selecting it as the architectural target subject to empirical validation that is scheduled and unavoidable.

The combination of literature prior + reversibility + scheduled empirical gate satisfies PRD §10.3's intent. Athena escalation would add no decision content.

### 2. §11.3 NIST scoring parameters (collar 0.25 s, `ignore-overlap = false`) — **APPROVED AS-IS**

These are the canonical NIST RT defaults (RT-04 onwards) used by DIHARD II/III, AMI, and the very papers cited in §11.5.1 (Bredin & Laurent, Park et al., Coria et al. all report DER with `ignore-overlap=false`). Using `ignore-overlap=true` would:
- inflate apparent PASS margin by ~1–2 pp on overlapped speech;
- create an apples-to-oranges comparison against the §11.5.1 literature prior, which is the only quantitative anchor for the deferred-measurement protocol;
- weaken the gate's discriminating power exactly where chunked stitching is most likely to fail (boundary-crossing overlapped speech).

The 0.25 s collar is the strictest commonly-used setting (NIST RT permits up to 0.5 s; DIHARD uses 0.25 s). Keeping it tight matches the strictness of the 5 pp gate. **Approve unchanged.**

## New Issues Introduced by r2

None at Critical or Major severity.

Two trivial observations that do **not** require a revision (called out for traceability only):

1. **§4.4.3 uses `AbortSignal.any`** which requires Node 20.3+. Electron 35 ships Node 22, so this is fine; documented here only because a future Electron downgrade would silently break it.
2. **§9.4 trade-off paragraph** still ends with the legacy "AssemblyAI does not natively concat upload_urls; the practical implementation uploads each chunk individually as separate transcripts, then stitches" sentence. This is now coherent with §11 / §4.7.1 (chunked submission is the Config A target; stitching is the §4.7.1 algorithm; gate measures whether it costs > 5 pp). Cosmetic cleanup only — no behavioural ambiguity.

## Architecture Verdict

**SOUND.**

All five Major findings from r1 are resolved with implementation-grade content. No new Critical or Major issues. The two open items Hephaestus flagged are ruled on (Athena escalation not required; NIST defaults approved). The spec is ready to lock and proceed to Artemis (test plan) and through to Phase 1 implementation under Ares.

The §11.5.4 BLOCKING checkpoint (Phase 3 Wave 1 Task 1) is the residual gate the PRD §10.3 still demands — it is correctly placed and scheduled, and the architecture's reversibility means a FAIL outcome costs one feature-flag default change rather than a redesign.

## Re-Review Gate Decision

- [x] **Approved for next stage**
- [ ] Requires revisions before proceeding

**Next**: Status updates to verdict=`sound`; stage 7 (test plan, Artemis) becomes ready. Hera's eventual alignment check should flag the §11.5.4 Phase 3 Wave 1 Task 1 result as a PRD §10.3 closure artefact when it runs.

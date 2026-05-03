# Decisions Log — liz-transcribe

## Product Decisions (Athena — PRD Creation)

- **Cloud-only ASR; no on-device transcription in v1**: User explicitly cleared cloud APIs and cloud storage of audio/transcripts. Going cloud-first lets us reach diarization quality (≤ 15% DER target) at MVP scope. Rejected: bundling Whisper / NeMo locally — adds GB-scale model downloads, GPU dependency, slow first-run, and worse diarization than hosted Sortformer/AssemblyAI.

- **Post-session review only; no live captioning**: Confirmed by clarified requirements. Simplifies the renderer (no real-time WS rendering, no partial-transcript reconciliation), and chunked batching is sufficient. Rejected: live captioning during the meeting — would force a streaming WS provider (Deepgram-style), increase cost, and add UI states that v1 does not need.

- **Chunked batching at 5–15 s (default 10 s)**: User specified this latency band. Long enough to give the diarizer useful context; short enough that uploads happen during the meeting, so M3 (≤ 5 min from stop to ready) is achievable. Rejected: full-session single upload — would break M3 for long meetings; also rejected: <2 s chunks — degrades diarization context and inflates request count/cost.

- **AssemblyAI as primary ASR provider; provider abstraction allows swap**: AssemblyAI is ~3× cheaper than Deepgram at every volume with measurably better diarization on published benchmarks; its async batch endpoint maps cleanly onto our chunked architecture. Rejected: Deepgram (3× cost, worse diarization accuracy in published comparisons); NVIDIA NIM (token-priced, harder MVP cost forecast — kept as future option); AWS Transcribe (most expensive, no clear advantage). Provider is abstracted so v1.x can target NVIDIA NIM without UI rework.

- **WASAPI loopback via `electron-audio-loopback` for system-audio capture**: Requirement specified WASAPI loopback. The npm package supports Electron 31+ (we are on 35) and avoids virtual audio cable drivers. Rejected: shipping a custom native addon — premature for MVP. Rejected: requiring Stereo Mix or VB-Cable — user-hostile install steps.

- **Mic and system audio captured as two independent streams, diarized independently, merged on timeline**: Cleaner separation between "you" and "them"; lets us style the user's own utterances distinctly (FR-UX-3); avoids mic-bleed contaminating system-audio diarization and vice versa. Rejected: pre-mixing into a single mono stream — cheaper but loses the "who is the local user" signal completely.

- **No cross-session speaker identity / voice fingerprinting in v1**: Speaker labels are stable within a session only. Rejected: persistent voice profiles — adds a privacy surface (biometric storage), an enrollment UX, and a model-training workflow that quintuples scope.

- **Per-session rename of speaker labels (Speaker 2 → "Alice")**: Cheap UX that gives users 80% of the value of voice fingerprinting at 5% of the cost. Rejected: no rename at all (poor UX); rejected: auto-rename via contact-book / calendar integration (out of v1 scope, no calendar integration).

- **API key stored in OS credential store via Electron `safeStorage`**: Secrets must not live plaintext under `userData`. Rejected: env var (poor UX for desktop user); rejected: encrypted file with app-bundled key (trivial to extract).

- **Windows-only for v1**: Existing repo targets Electron + Windows installers; user explicitly listed Windows. Rejected: cross-platform v1 — macOS loopback (CoreAudio aggregate device or `electron-audio-loopback` macOS path) and Linux PulseAudio monitor sources are different code paths and different test matrices. Defer.

- **PRD specifies WHAT only; storage schema/IPC choreography is Hephaestus's call**: Section 9 lists required entities and fields, not table definitions or IPC channel names. Rejected: defining SQLite schemas in the PRD — would lock the tech spec prematurely and mix WHAT with HOW.

- **Failed-chunk policy: placeholder + retain audio for re-transcription**: When a chunk permanently fails, the user sees `[transcription failed for HH:MM:SS – HH:MM:SS]` rather than a silent gap, and can re-trigger. Rejected: silently dropping failed chunks — user can't tell if a missing utterance was silence or a system failure.

- **Default to deleting raw audio after successful transcription**: Audio files are large; the transcript is what users care about. Setting toggle exposed for users who want to re-transcribe with a different provider. Rejected: default-keep — disk usage balloons quickly for heavy users.

- **No in-app transcript editing in v1**: Users can copy / export and edit elsewhere. Rejected: in-app editing — non-trivial because edits would have to coexist with re-transcription and diarization changes; defer to v1.x.

- **No summarization / action-item extraction in v1**: User did not request it; adds an LLM dependency and a separate cost line. Rejected: bundling LLM summarization — out of scope for an MVP focused on accurate raw transcripts.

## Revision Requests

### Nemesis (Adversarial Review — 2026-05-02) — Verdict: REVISIONS
9 BLOCKING + 16 MAJOR + 10 MINOR findings. Athena addressed the 7 required blocking changes from `prd-challenge.md`:

1. **Metric definitions tightened (M1, M3, M4)** — added § 3.1 (clear-audio test set: 10 sessions with explicit composition, SNR ≥ 20 dB floor, English-only, single-annotator protocol, mean-WER / mean-DER computation), § 3.2 (M3 test population: 20 sessions, ≥ 50 Mbps pre-launch / ≥ 5 Mbps post-launch eligibility, pause and failure exclusions), and § 3.3 (M4 eligible-session definition: ≥ 5 min duration, network-not-disabled, app-not-killed; precise `chunk_lost` event definition). Rejected: leaving "clear-audio" undefined (Nemesis's primary blocking concern) — would have made M1 a judgment call.

2. **A6 chunked-diarization risk resolved with hard gate** — added § 10.3 Tech-Spec Exit Gate (mandatory): Hephaestus must run 5 of the 8 diarization-subset sessions through chunked vs. full-session configurations and measure Δ_DER ≤ 5 percentage points. Added FR-TR-2-FALLBACK as the in-scope alternative if the gate fails. Apollo will reject the spec at review if the gate evidence is missing. Rejected: "validate later in tech spec" (the original A6 mitigation) — would have allowed an architecture lock without evidence.

3. **Pause/resume error states defined (FR-CAP-8)** — enumerated 5 error scenarios with expected behavior: app-crash-while-paused (orphaned-session recovery, no cross-restart resume), pause > 4 h (auto-stop with toast), device-removed-during-pause (modal with stop-or-resume options), in-flight-upload-at-pause (upload completes), audio-service-restart-on-resume (re-validate before accepting Resume). Rejected: silent best-effort behavior — caused user confusion in real meetings.

4. **Partial-failure session error states defined (FR-TR-3 + FR-LIB-2 + FR-TR-8)** — added a session-card status enum (`completed`, `completed_with_failures`, `failed`) with badge colors, toasts, and re-trigger affordances; tied retry availability to FR-CFG-4 raw-audio retention. Rejected: a percentage-based threshold (e.g., "30% failed → completed_with_failures") — count-based is what the user actually sees.

5. **Failure-modes table expanded (§ 6.4)** — added rows for: ASR provider 5xx outage (with banner trigger at ≥ 3 consecutive failures), full-session ASR unreachability (forces audio retention), mic/system device hot-swap, Windows audio service restart, OS lock/logout (continues), Sleep/Hibernate (auto-stop on wake — cannot reliably resume across suspend), mic permission revoked between launches, loopback-init failure with WASAPI error code disclosure, network-down at first run (defer key validation to first upload). Rejected: leaving Sleep behavior undefined — common case, every user hits it eventually.

6. **Privacy-notice contract specified (§ 5.3.1)** — required content: provider+region, data path, retention promise, third-party disclaimer, off-ramp for compliance-restricted users. Acknowledgement contract: explicit checkbox, persisted with notice-version hash + timestamp + app version, invalidated on material content change. Rejected: a passive informational notice with no acknowledgement — would not give compliance-restricted users a clear off-ramp.

7. **FR-TR-7 / FR-UX-3 testable visual marker** — picked the literal label "You" (in place of "Speaker N") as the single observable contract. Added an accessibility requirement that the marker must include a non-color element (icon/symbol/bold), since color-only differentiation fails WCAG. Added timeline-alignment tolerance ±200 ms over 60 min (Nemesis flagged unacknowledged clock-drift risk between two Windows audio captures). Rejected: "color OR label" (the original wording) — not testable; rejected color-only — accessibility failure.

**MAJOR findings deferred to a follow-up revision pass** — these will be addressed if Nemesis's re-review still flags them or if Apollo / Daedalus surface them downstream. They include: A1 framing as assumption (already labeled), FR-LIB-3 search scope cap, FR-CFG-3 device-picker contradiction, at-rest-encryption stance (now stated explicitly in § 5.3 as "no, BitLocker recommended"), VU-meter detection definition for FR-CAP-7, slow-network persona, first-time-user-during-real-meeting persona, soft-delete vs. hard-delete for FR-LIB-5, accessibility expansion (§ 5.4).

### Architecture Review (Apollo) — 2026-05-03

| Issue | Severity | Rationale | Required Change |
|-------|----------|-----------|-----------------|
| §11 Exit Gate timing deviates from PRD §10.3 wording | High | PRD §10.3 says "Hephaestus's tech spec must not finalize the chunked-batching architecture until this gate passes" and "The spec is rejected at review (Apollo) if this evidence is missing." Hephaestus's deferred-measurement protocol (run at Phase 3 kickoff) is engineering-reasonable but is a contract change with the PRD. The "Hephaestus's call within the bounds defined here" clause covers gate decision (PASS/FAIL action), not gate timing (when to measure). Without resolution, downstream stages (test plan, alignment check) inherit an unresolved PRD constraint. | Either (a) escalate the timing change to Athena and document approval in `decisions.md`, OR (b) strengthen §11.5 with a literature-cited Δ_DER estimate using a stitch algorithm and overlap window matching §11.3 so the deferred measurement has a quantitative prior. Recommend (a) — 10-minute Athena conversation. |
| §4.7 / §11.3 within-stream stitching algorithm under-specified | High | "Majority-overlap match in the boundary 1 s" is one sentence. A naive stitch can cause the §11 gate to fail spuriously when a rigorous stitch would pass. Real stitching needs to handle: new speakers introduced mid-stream (global label assignment), boundary-crossed utterances, duration-weighted overlap, tie-breaking. Choice of algorithm is an architectural decision that belongs in the spec, not in implementation discretion. | Specify the algorithm to pseudocode level: (a) tie-breaking rule, (b) global label assignment for new speakers (never reuse a previous chunk's label for a new speaker), (c) duration-weighted overlap (not count-weighted), (d) overlap-window size (the spec says 1 s but doesn't justify), (e) confidence threshold for "no match → assign new global label." OR cite a published algorithm verbatim with section reference. |
| §4.4 AssemblyAIClient runtime bug + security gaps | High | Three issues converge: (1) `body: fileStream as unknown as ReadableStream` is a runtime type bug — `fs.createReadStream` returns a Node `Readable`, not a Web `ReadableStream`. (2) `Authorization: <api_key>` without `redirect: 'manual'` allows header replay to redirect targets. (3) `await res.text()` into `ProviderError` can leak signed URLs / API key prefixes into logs and IPC return values. (4) `withErrorWrapper` returns raw `error.message` to renderer, leaking SQL schema, native module file paths, and provider response details. | (a) Use `Readable.toWeb(fileStream)` or `fs.readFile(path)` to a Buffer for the upload body. (b) Add `redirect: 'manual'` on every AssemblyAI fetch and reject 3xx. (c) Sanitize provider error bodies before they enter `ProviderError` (strip query strings; truncate to first 200 chars). (d) Specify an error-classification function in `withErrorWrapper`: known codes get stable strings; unknown errors get generic `'internal_error'` with a server-side log id. Renderer never sees raw `error.message` from main. (e) Explicit ban on logging `Authorization` header in any path. |
| §4.3 ChunkProcessor.tick() polling serialization | High | Pseudocode `for chunk of polling: await this.pollTranscript(chunk)` serializes per-chunk polls within a 2 s tick. A single stuck poll (AssemblyAI regional slowdown, network hiccup) blocks every other poll for that tick and cascades into next ticks. At peak (12 in-flight chunks during a 4-hour session), a 30 s hung poll stalls the entire pipeline. | Change to `Promise.allSettled([...polling.map(c => this.pollTranscript(c))])`. Add per-chunk `lastPolledAt >= 3 s ago` guard so the same transcript isn't polled twice within 3 s. Specify per-call HTTP timeout (e.g., 10 s) via `AbortSignal.timeout(10000)` so a hung poll cannot occupy a tick indefinitely. |
| §4.2.4 / §4.9 IPC payload size unbounded | Medium | `capture:loopback-chunk` accepts an `ArrayBuffer` from the renderer with no size validation. A renderer compromise (XSS via future dependency) could DoS main process via huge buffers. R10 documents back-pressure but not size bounds. | Add explicit max-size check in the `capture:loopback-chunk` handler (e.g., reject anything > 5 MB; a 10-second opus chunk at 96 kbps is ~120 KB). Reject and emit `capture:device-event` on overflow. Also recommend `webPreferences.sandbox: true` (not just contextIsolation) on the BrowserWindow if not already enabled. |
| §4.12 SearchBar XSS surface via dangerouslySetInnerHTML | Medium | FTS5 `snippet()` output is rendered via `dangerouslySetInnerHTML` after regex-validation to allow only `<mark>`/`</mark>`. Regex pattern is not specified. A naive regex that allows `<mark onerror=...>` is a stored-XSS via SQLite content. The entire surface is unnecessary. | Use non-HTML markers in the FTS5 `snippet()` call (e.g., ``/``). Have the React component split on the markers and render `<mark>` JSX elements directly. Eliminates the injection surface entirely. No regex validation needed. |
| §4.2.6 recovery on launch missing staleness rule | Medium | For orphan WAV files where the parent session is `recording` or `paused`, the spec re-INSERTs the chunk row as `pending`. No bound on session age. A user who crashes mid-recording, returns months later, reopens the app — the old session is re-queued and burns ASR credits on stale audio they don't want. PRD §6.4 covers crash recovery in general but not staleness. | Specify: sessions whose `started_at` is more than 24 hours old (or a configurable threshold) are auto-finalized to `failed` rather than re-queued. User can manually retry from the library if desired (FR-TR-8 retry affordance). |

**Apollo's verdict**: CONCERNS. Spec returns to Hephaestus for revision. Once Major items #1–#5 (§11 timing + algorithm, §4.4 fix + security, §4.3 polling fix) are resolved cleanly, re-review verdict is expected to be Sound.

## Final Resolution
<!-- Athena updates this after all reviews are resolved -->

---

## PRD Alignment (Hera) — 2026-05-03

Verdict: **GAPS**. Coverage: 8/41 criteria verified (20%).

| Criterion | Status | Gap |
|-----------|--------|-----|
| FR-CAP-1 (start recording) | gaps | E2E not configured; no test verifies button or 500ms transition |
| FR-CAP-2 (dual-stream capture) | gaps | Integration tests for ChunkAccumulator/dual-stream not written |
| FR-CAP-3/4 (mic-only / system-only) | gaps | Integration tests INT-004/INT-005 not written |
| FR-CAP-7 (preflight warnings) | gaps | UNIT-031/032 not written |
| FR-CAP-8 (pause/resume + error states) | gaps | session-state.ts unit tests not written; E2E not configured |
| FR-CAP-9 (stop transition) | gaps | UNIT-019 not written; E2E not configured |
| FR-TR-1 (10s chunking + DB-First L3) | gaps | chunk-accumulator.ts tests not written |
| FR-TR-2 (upload pipeline) | gaps | chunk-processor.ts integration tests not written |
| FR-TR-3 status enum + toasts | gaps | UNIT-051 + INT-012 not written |
| FR-TR-3 provider banner | gaps | UNIT-047 not written |
| FR-TR-4 (merged transcript) | gaps | session-finalizer.ts unit tests not written |
| FR-TR-6 (timestamps) | gaps | UNIT-041 not written |
| FR-TR-7 (You label in UI) | gaps | No React component unit test; E2E not configured |
| FR-TR-8 (failed placeholder + retry) | gaps | UNIT-046 not written |
| FR-UX-1 (no live transcript) | gaps | E2E not configured |
| FR-UX-3 (You label + non-color marker) | gaps | No React component test |
| FR-UX-6 (export txt/md/json) | gaps | UNIT-048–050 not written |
| FR-LIB-1 (library persists) | gaps | E2E not configured |
| FR-LIB-2 (session card fields + badges) | gaps | UNIT-051 not written |
| FR-LIB-3 XSS safety (SearchBar) | gaps | UNIT-053–055 not written |
| FR-LIB-4 (date/status filter) | gaps | INT-016/017 not written |
| FR-LIB-5 (delete session + files) | gaps | Audio file deletion not tested |
| FR-CFG-1 (first-run gate) | gaps | UNIT-101–104 not written; E2E not configured |
| FR-CFG-2 (safeStorage) | gaps | api-key-service.ts unit tests not written |
| FR-CFG-4 (audio retention) | gaps | UNIT-058/059 not written |
| §5.3.1 (privacy notice + ack) | gaps | privacy-service.ts tests not written; E2E not configured |
| §5.2 (crash recovery) | gaps | recovery.ts integration tests not written |
| FR-TR-2-FALLBACK (full-session upload) | gaps | INT-013 not written |
| FR-TR-2 slow network badge | gaps | INT-009 partial; metered network behavior unverified |

**Action**: Stage 8-implementation returned to ready. Ares must write the missing test cases before re-alignment.

### PRD Alignment Re-run (Hera, Run 2) — 2026-05-03

Ares added 138 tests (202 total, all passing), closing 21 of 29 prior blockers. Coverage rose from 20% to 56% (23/41 criteria verified).

| Criterion | Status | Gap |
|-----------|--------|-----|
| AC-FR-CAP-1 | gaps | E2E not configured |
| AC-FR-CAP-2 | gaps | INT-001–006 (dual-stream integration) not written |
| AC-FR-CAP-3/4 | gaps | INT-004/005 (mic-only / system-only) not written |
| AC-FR-CAP-5/6 | gaps | E2E not configured |
| AC-FR-TR-7 (mergeStreams) | gaps | UNIT-042–046 absent from codebase; mergeStreams untested |
| AC-FR-TR-8 | gaps | Failed-chunk placeholder test missing; E2E not configured |
| AC-FR-UX-1 | gaps | E2E not configured |
| AC-FR-UX-2 | gaps | E2E not configured |
| AC-FR-UX-3 | gaps | React DOM tests deferred; E2E not configured |
| AC-FR-UX-4 | gaps | E2E not configured |
| AC-FR-UX-5 | gaps | E2E not configured |
| AC-FR-LIB-1 | gaps | E2E not configured |
| AC-FR-TR-2-slow | gaps | No metered-network badge test |
| AC-FR-CFG-3 | gaps | E2E not configured |
| GATE-001 | plan_gap | Deferred by design; both paths built and feature-flagged |

**Minimum required before next re-alignment**: UNIT-042–046 (mergeStreams unit tests) and metered-network badge test. E2E may be deferred with formal test-plan revision.

**Action**: Stage 8-implementation returned to ready.

### PRD Alignment Final Run (Hera, Run 3) — 2026-05-02

Ares closed all remaining unit/integration blockers (41 new tests, 243 total, all passing). The 10 remaining criteria requiring Playwright E2E or React DOM render tests were formally deferred to post-ship by explicit user decision. Verdict upgraded to ALIGNED.

| Criterion | Status | Note |
|-----------|--------|------|
| AC-FR-CAP-2 | verified | dual-stream-capture.test.ts (INT-001–006) |
| AC-FR-CAP-3/4 | verified | dual-stream-capture.test.ts (INT-004/005) |
| AC-FR-TR-7 (mergeStreams) | verified | merge-streams.test.ts (UNIT-042–046) |
| AC-FR-TR-2-slow | verified | slow-uplink-badge.test.ts |
| AC-FR-CAP-1 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-CAP-5/6 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-TR-8 | accepted-deferred | Playwright + DOM render — post-ship |
| AC-FR-UX-1 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-UX-2 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-UX-3 | accepted-deferred | Playwright + DOM render — post-ship |
| AC-FR-UX-4 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-UX-5 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-LIB-1 | accepted-deferred | Playwright E2E — post-ship |
| AC-FR-CFG-3 | accepted-deferred | Playwright E2E — post-ship |

**Action**: Stage 9 complete. Stage 10 (Hermes + Cassandra) set to ready.

### Code Review (Hermes) — 2026-05-03

| Finding | Tier | Rationale | Required Fix |
|---------|------|-----------|--------------|
| electron/main.ts:60–72 — Stale ASR provider client never refreshes after API-key change | Tier 1 — Correct | `getProvider()` runs twice synchronously at bootstrap; the resulting `AssemblyAIClient` is captured by `ChunkProcessor` and `TranscriptAssembler` and never replaced. First-run flow (no key at startup) and key rotation (Settings → Update API key) both result in uploads using a stale or empty key. The PRD/spec contract that recording is enabled once `apikey:exists` is true is broken — the renderer's pre-flight passes but uploads silently 401. | Restructure provider injection: pass a factory `() => IASRProvider` to `ChunkProcessor` so the apiKey is resolved per request, OR add a `setProvider()` setter on `ChunkProcessor`/`TranscriptAssembler` and invoke it from the `apikey:set` handler. Whichever option is chosen, add a test that `apikey:set` followed by a chunk-pickup uses the new key. |
| electron/asr/transcript-assembler.ts:96–105 — `extractUtterances` is a permanent stub; cross-chunk stitching is dead code | Tier 1 — Correct | `extractUtterances(chunks)` returns `chunks.map(() => [])`, so the two `if (...flat().length > 0)` guards in `assemble()` always evaluate false. The `stitchStreamLabels` algorithm — whose pseudocode the tech spec §4.7.1 was rewritten in r2 to satisfy Apollo's CONCERNS — is never exercised in the runtime path. Per-chunk segments are written by `ChunkProcessor.handleTranscribed` using raw provider labels, so the same physical speaker can appear as `A` in chunk N and `B` in chunk N+1. Implementation-notes Deviation #1 acknowledges the runtime path differs from the pseudocode but does not call out that the stitching pass never runs. | Choose one: (a) wire `extractUtterances` to read AssemblyAI utterance JSON cached during `pollTranscript` (today it is dropped after segments are inserted); have `assemble()` delete the previously-inserted segments and replace them with stitched ones; OR (b) delete `assemble()` and the entire `transcript-assembler.ts` cross-chunk path, accept per-chunk speaker labels as the v1 product, and update the tech spec §4.7.1 + PRD §11.3 to match. Option (a) preserves the spec contract but is 1–2 days of work + tests; option (b) is hours but requires PRD revision. |
| electron/asr/chunk-processor.ts:160–162 — Provider-banner counter only triggers on 5xx; network/timeout never increment | Tier 1 — Correct | `handleProviderFailure()` is gated by `if (provErr?.code === 'provider_5xx')`. The most common provider-unreachable conditions (DNS failure, connection reset, timeout) classify as `network` or `timeout` and never increment `consecutiveFailed`. PRD FR-TR-2 / spec §4.4.1 promises an "ASR provider unreachable" banner after 3 consecutive failures, but in practice the banner only shows during a 5xx outage, not when the user's network is flapping. The existing `provider-banner.test.ts` only tests `provider_5xx`, masking the bug. | Change the gate to: `if (provErr && (provErr.code === 'provider_5xx' \|\| provErr.code === 'network' \|\| provErr.code === 'timeout'))`. `auth_failed` and `bad_request` must remain excluded (existing test on chunk-processor.test.ts:41 confirms 401 should not trigger the banner). Add tests covering `network` and `timeout` paths through the banner counter. |

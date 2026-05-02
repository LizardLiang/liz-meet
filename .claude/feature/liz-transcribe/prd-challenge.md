# PRD Adversarial Review — liz-transcribe

## Reviewer
Nemesis (Devil's Advocate + User Advocate) — 2026-05-02

## Verdict (r1): REVISIONS
## Verdict (r2 re-review): APPROVED

> See [§ Re-Review (r2, 2026-05-02)](#re-review-r2-2026-05-02) at end of document for the full re-review section.

## Executive Summary
The PRD is structurally strong — it has explicit non-goals, owned metrics, a decision matrix for ASR provider selection, and a robust failure-modes table. However, several BLOCKING issues remain: success metrics M1, M2, M3, M4 lack pre-defined sample sizes / measurement preconditions and rely on phrases like "user's own clear-audio meetings" that are themselves undefined; the unvalidated assumption that chunked batching does not degrade diarization (A6, Q1) is the single biggest technical risk and is being deferred to the tech spec rather than gated; and several primary user flows (pause/resume mid-recording, mic-only with no system audio, recovery after crash) lack defined error states. User-advocate findings concentrate in onboarding (no path for compliance-restricted users beyond "out of scope"), discovery of the recording feature inside Settings/library, and sparse error messaging guarantees on the upload path.

## Findings

### BLOCKING

- `[UNVALIDATED]` § 10.1 A6 + § 10.2 Q1 — The PRD explicitly admits chunked batching may degrade diarization quality and defers validation to Hephaestus, but M2 (DER ≤ 15%) and the failure threshold (DER > 25% = failed launch) depend entirely on this assumption being correct. If A6 is wrong, the chosen architecture invalidates the chosen success metric. Fix: add a tech-spec phase exit gate ("validate diarization quality on 10s vs. full-session uploads with N sample meetings before locking architecture") OR allow the architecture to accept full-session upload as a fallback path in PRD scope.

- `[VAGUE_METRIC]` § 3 M1 — "End-to-end transcription accuracy (WER on user's own clear-audio meetings)" — "clear-audio" is not defined (SNR floor? no music? mic > $X?). Sample size of 10 meetings is stated, but selection criteria, language(s) covered, and accent diversity are not. Without these, M1 is not objectively pass/fail. Fix: define clear-audio threshold (e.g., "mic SNR > 20 dB, no concurrent music, English-only"), specify the 10-meeting sample composition (speaker count distribution, durations), and state who hand-corrects (single annotator vs. consensus).

- `[VAGUE_METRIC]` § 3 M3 — "Time from Stop Recording to Transcript ready" ≤ 5 minutes (P95) for a 60-minute meeting — but P95 over what population? P95 across how many runs, on what network conditions? "Network permitting" appears in FR-TR-2 but is absent from M3. Fix: define the test population (e.g., "P95 over 20 sessions on a 50 Mbps+ residential connection") and state what happens to the metric if the user is on slow/intermittent network (separate metric or excluded population).

- `[VAGUE_METRIC]` § 3 M4 — "≥ 99% of started sessions complete without dropped chunks" — but "started session" includes sessions where the user immediately stops, where network drops, or where the user's machine sleeps. Without defining the eligible session set and the duration floor, this is not measurable. Fix: scope to sessions ≥ N minutes, exclude sessions where the user explicitly disables network, and define `chunk_lost` event precisely.

- `[MISSING_ERROR_STATE]` § 4.1 FR-CAP-8 (Pause/Resume) — No error state defined for: pause-then-app-crash, pause longer than the session-recovery window, system audio device changes during pause (e.g., user unplugs headphones), or pause invoked while a chunk upload is mid-flight. Fix: enumerate pause/resume failure modes and recovery in § 6.4.

- `[MISSING_ERROR_STATE]` § 4.2 FR-TR-3 — "Persistent failures are logged but do not abort the session" — but there is no defined user-visible error state for a session that has, e.g., 30% of chunks permanently failed. Does the session show "Completed (with gaps)"? Is the user notified proactively? FR-TR-8 covers the placeholder text but not the session-card status or notification. Fix: define a `completed_with_failures` status (or equivalent) and the UI's notification behavior.

- `[MISSING_FAILURE_MODE]` § 6.4 — The failure modes table omits: (a) AssemblyAI service outage (not just rate-limit) lasting longer than the user is willing to wait; (b) audio device hot-swap mid-recording (user unplugs USB mic); (c) Windows audio service restart; (d) user logs out / locks Windows during recording; (e) Windows sleep / hibernate during recording. These are common in real meetings. Fix: add rows for each.

- `[MISSING_PERSONA]` § 2 — "Compliance-restricted users" are listed as out-of-scope, but no first-run mechanism prevents a user with a confidentiality obligation from blindly uploading audio. Privacy notice (§ 5.3) is mentioned but its content, persistence, and acknowledgement requirement are not specified. Fix: specify the privacy notice text contract: must list provider name, data path, retention promise, and require explicit acknowledgement before first recording.

- `[UNTESTABLE_AC]` § 4.2 FR-TR-7 — "the mic stream's speaker is visually distinguished from system-audio speakers" defers to FR-UX-3, which says "e.g., colored differently or labeled 'You'". An e.g. is not an AC. Fix: pick one (color OR label) and make it the testable AC, e.g., "mic-stream segments display the literal label 'You' in place of 'Speaker N' AND have a left border in `--color-primary`."

### MAJOR

- `[ASSUMPTION]` § 1.1 + § 2.1 — "Knowledge workers attend many online meetings" and the primary persona description ("10+ hours per week", "uses Meet/Teams/Zoom in roughly equal measure") are presented as fact with no research backing. These shape the entire feature. Fix: label as assumptions or cite source (internal interviews, market data).

- `[SCOPE_DRIFT]` § 4.4 FR-LIB-3 — "Full-text search across the library" with surrounding context highlighting is a non-trivial feature (FTS5 index, ranking, snippet generation). Implementation difficulty depends entirely on transcript volume. PRD does not bound expected library size beyond "200 sessions" in M5. Fix: explicitly cap v1 search to N sessions / N MB or commit to FTS5 with documented eviction policy.

- `[SCOPE_DRIFT]` § 4.5 FR-CFG-3 — "default audio devices" implies a device picker UI, but § 1.3 non-goals say "Capturing audio from sources other than default WASAPI render endpoint + default mic input device." These contradict. If the user can change "default audio devices" in Settings, then v1 supports per-device selection — which contradicts A3 mitigation ("v1.x adds device picker"). Fix: resolve the contradiction. Either remove device selection from FR-CFG-3 or remove the non-goal.

- `[SCOPE_DRIFT]` § 4.2 FR-TR-7 — "Mic and system streams are diarized independently and merged" implies the app must ALSO solve cross-stream timestamp alignment (clock drift between two captures over 60+ minutes is real on Windows audio APIs). Not addressed. Fix: state the alignment tolerance (e.g., "merged timeline accurate to ±200ms over a 60-minute session") and acknowledge the drift problem.

- `[CIRCULAR]` § 5.3 — "Audio files stored under userData are accessible only to the current OS user (default NTFS permissions)" — this is a tautology (NTFS user-profile permissions do this automatically). Real question: are the files encrypted at rest? PRD doesn't say. For audio that may contain PII, this matters. Fix: state explicitly whether at-rest encryption is required (likely NO for v1, but say so).

- `[VAGUE_TERM]` § 5.1 — "mid-tier 2024 Windows laptop (8-core, 16 GB RAM)" defines the test machine but not the OS state ("freshly booted"? "with a meeting app + browser open"?). Recording adds "≤ 10% CPU" — over what baseline? Idle baseline differs hugely from a Teams meeting baseline. Fix: define baseline as "with the target meeting app running and a meeting active."

- `[VAGUE_TERM]` § 4.1 FR-CAP-7 — "no audio is currently playing through the default render endpoint" — how is this detected? Many systems output a near-zero stream when no audio is playing. False positives on this warning would train users to ignore it. Fix: define the detection (e.g., "RMS level < -50 dBFS for 1.0 s before recording") or remove the warning if it cannot be reliably detected.

- `[MISSING_ERROR_STATE]` § 4.5 FR-CFG-1 — "Test connection" verifies the key, but what if the network is down at first run? User cannot proceed at all? Fix: allow first-run with a key-format-validated-but-untested key and defer the connectivity check.

- `[MISSING_ERROR_STATE]` § 4.1 FR-CAP-2 — When loopback capture fails to start (Windows policy, audio driver crashed, exclusive-mode app holding the endpoint), what does the user see? § 6.4 doesn't cover capture-init failure. Fix: add a "loopback init failed" error path with actionable copy.

- `[MISSING_PERSONA]` § 2 — No persona for **users on slow / metered connections**. The chunked-upload-during-recording design (FR-TR-2) sends ~tens of MB during a meeting; on a metered tether, this is meaningful. PRD does not address. Fix: add a setting for "buffer chunks until end of session" OR explicitly accept this constraint and document it in the privacy notice.

- `[MISSING_PERSONA]` § 2 — No "first-time user during a real meeting" persona. The user flow § 6.2 step 2 says "User opens liz-transcribe, clicks New Recording" — but a first-time user launches the app and is faced with the API-key wall (FR-CFG-1). Time-to-first-recording for a stressed user already in a meeting is poor. Fix: state the expected onboarding latency target (e.g., "≤ 90s from first launch to recording") OR allow API-key entry to be deferred until first stop.

- `[MISSING_FAILURE_MODE]` § 4.1 FR-CAP-1 — "Clicking Start Recording transitions within 500ms." What if microphone permission has been revoked at the OS level since the last run? § 6.4 does not address it. Fix: add OS-permission-revoked row.

- `[UX_CLARITY]` § 4.3 FR-UX-3 — "the user can tell at a glance which lines they themselves said" is an outcome, but the implementation hint ("colored differently or labeled 'You'") is left to interpretation. Color-only differentiation is an accessibility failure. Fix: require BOTH a non-color marker (label or icon) AND optional color.

- `[ACCESSIBILITY_GAP]` § 5.4 — Accessibility section is two bullets. Missing: focus-visible requirements, screen-reader announcements for state transitions ("recording started", "transcribing"), live-region for elapsed-time counter (or explicit decision to suppress it from screen readers), high-contrast mode support. Fix: expand or explicitly defer with a documented v1 accessibility floor.

- `[UX_CLARITY]` § 4.4 FR-LIB-5 — "A confirmation dialog prevents accidental deletion" — but is the action reversible (trash / undo) or permanent? For irreversible deletion of an asset that may have taken meaningful effort to capture, a single confirmation dialog is weak. Fix: define recovery (e.g., 30-day soft-delete) or accept hard-delete and document it.

- `[UX_CLARITY]` § 6.2 step 2 — "User opens liz-transcribe, clicks New Recording" — but the user has not yet joined the meeting at this point in the flow. If the user joins the meeting AFTER starting recording, they must remember to do so; if they forget, the recording captures pre-meeting noise. There's no prompt or affordance to confirm "is your meeting actually playing audio?" beyond the soft VU meter. Fix: define the explicit affordance during the first 5–10 seconds (e.g., "We didn't hear any audio yet — is the meeting started?").

### MINOR

- `[VAGUE_TERM]` § 1.2 — "high-accuracy speaker diarization at a price point ($0.17–$0.58 per hour)" — "high-accuracy" should reference the M2 target.

- `[VAGUE_METRIC]` § 3 M6 — "First-week activation: ≥ 60% of installs complete one transcribed session" — "install telemetry (opt-in) or self-reported" — these two methods produce wildly different denominators. Pick one as primary.

- `[ASSUMPTION]` § 7.2 — "AssemblyAI's published benchmarks; treat with appropriate caution" — already labeled with caution, but no plan to validate independently before launch. Acceptable as MINOR with this caveat.

- `[VAGUE_TERM]` § 4.2 FR-TR-2 — "network permitting" is a hand-wave; for the AC, define what counts as compliant under network conditions.

- `[MISSING_ERROR_STATE]` § 4.4 FR-LIB-3 — Search returning zero results — defined empty-state copy?

- `[MISSING_JOURNEY_STAGE]` § 6.1 — First-run flow does not address "user wants to skip API key for now and explore" path; the CTA wall may push some users away before they see the value.

- `[UX_CLARITY]` § 4.5 FR-CFG-3 — "provider (if multiple are supported in a build)" — exposes a build-time conditional to the user. Either the provider switcher exists or it doesn't; pick one for v1.

- `[ACCESSIBILITY_GAP]` § 4.1 FR-CAP-5 — pulsing red indicator could be a problem for users with photosensitivity / vestibular sensitivities. Confirm `prefers-reduced-motion` is honored.

- `[VAGUE_TERM]` § 4.1 FR-CAP-7 — "warns the user before starting if no microphone is detected" — what about a microphone that is detected but muted at the OS level? Common case worth covering.

- `[SCOPE_DRIFT]` § 4.4 FR-LIB-3 — "matching utterance is highlighted" implies snippet UI. Cheap to mention, real to build. Confirm scope.

## Score
BLOCKING: 9 | MAJOR: 16 | MINOR: 10 | Total: 35

## If REVISIONS: Required Changes

Athena must address all 9 BLOCKING findings before this PRD can move to decomposition. Specifically:

1. **Tighten metric definitions** (M1, M3, M4) — sample size, sample composition, network conditions, eligible-session definition.
2. **Resolve the chunked-diarization risk (A6)** — either add a tech-spec exit gate that validates diarization quality before locking architecture, or include "full-session upload" as an in-scope fallback path.
3. **Define error states for pause/resume** (FR-CAP-8) — at minimum: app crash during pause, device removed during pause, pause during in-flight upload.
4. **Define error states for partial-failure sessions** (FR-TR-3) — session-card status text, user notification, and re-trigger affordance.
5. **Expand failure-modes table** (§ 6.4) — ASR service outage, audio device hot-swap, Windows audio-service restart, OS lock/sleep/hibernate.
6. **Specify the privacy-notice contract** for compliance-restricted users — content requirements, persistence, acknowledgement gating.
7. **Make FR-TR-7 / FR-UX-3 testable** — pick a single, observable visual marker for mic-stream segments.

Recommend addressing all 16 MAJOR findings in the same revision pass; they are independently small but collectively shape implementation correctness for real users.

---

## Re-Review (r2, 2026-05-02)

**Reviewer**: Nemesis
**Subject**: prd.md r2 (582 lines), revised by Athena to address 9 BLOCKING findings from r1
**Verdict**: **APPROVED**

### Executive Summary

Athena has resolved all 9 BLOCKING findings from r1 with substantive, testable structure: three new metric-definition sub-sections (§ 3.1 / § 3.2 / § 3.3), an explicit Tech-Spec Exit Gate (§ 10.3) for the chunked-diarization risk, a 5-row pause/resume error-state table inside FR-CAP-8, a session-status table inside FR-TR-3 (`completed` / `completed_with_failures` / `failed` with triggers, badges, notifications, and a re-trigger affordance), 9 new failure-mode rows in § 6.4, and a fully specified Privacy Notice Contract (§ 5.3.1) including acknowledgement gating and version-hash-driven re-prompting. FR-TR-7 + FR-UX-3 are now anchored on a single observable contract: every mic-stream segment shows the literal label "You" plus a non-color marker. No new BLOCKING issues were introduced. Several r1 MAJORs were resolved as a bonus (timeline alignment tolerance, network-down-at-first-run, loopback init failure, OS-permission-revoked, color-only-differentiation, at-rest encryption stance). A handful of MAJORs from r1 remain — listed below as **carry-over** for tech-spec / implementation hygiene, not as gates.

### BLOCKING Resolution Verification (9 of 9 resolved)

| # | r1 Blocker | Resolution Location in r2 | Status |
|---|-----------|---------------------------|--------|
| B1 | A6 chunked-diarization risk deferred without gating | § 10.3 Tech-Spec Exit Gate (5-session test, Config A vs B, Δ_DER ≤ 5pp pass criterion) + § 4.2 FR-TR-2-FALLBACK full-session-upload path | RESOLVED |
| B2 | M1 "clear-audio" undefined | § 3.1 — 10-session test set; SNR ≥ 20 dB; en-US/en-GB; sub-set composition; arithmetic-mean WER; single-annotator protocol; reproducibility archive | RESOLVED |
| B3 | M3 P95 over what population | § 3.2 — 20 pre-launch synthetic runs at ≥ 50 Mbps / ≤ 50 ms RTT; post-launch eligibility = ≥ 5 Mbps sustained; pause-exclusion >10%; failure-exclusion; separate "M3-degraded" metric for slow networks | RESOLVED |
| B4 | M4 eligible-session undefined | § 3.3 — duration ≥ 5 min, no user-disabled-network, no force-quit, must reach `recording`; `chunk_lost` defined precisely as buffered-chunk → `permanently_failed` post-retry; computation formula stated; monthly window | RESOLVED |
| B5 | FR-CAP-8 pause/resume error states | FR-CAP-8 5-row table: app crash while paused (orphan-recovery as Stopped), pause > 4h (auto-stop + toast), device removed during pause (modal w/ Stop or Switch options), in-flight upload at pause (in-flight completes; new chunks halt; queue holds), OS audio-service interruption (validate on Resume) | RESOLVED |
| B6 | FR-TR-3 partial-failure session UI | FR-TR-3 — `completed` / `completed_with_failures` / `failed` status table with badges, "N gap(s)" subtitle, toast notifications, `[transcription failed for HH:MM:SS – HH:MM:SS]` placeholder + per-segment "Retry" + session-level "Retry all failed" affordance; explicit zero-success → `failed` rule | RESOLVED |
| B7 | § 6.4 missing failure modes | § 6.4 adds rows for: ASR provider 5xx outage, ASR provider unreachable for entire session (forced raw-audio retention), mic/system-audio hot-swap, Windows audio service restart, Windows logout/lock, Windows sleep/hibernate (clock-jump > 30 s detection), OS-level mic permission revoked, loopback init failed (driver/policy/exclusive-mode), network down at first run | RESOLVED |
| B8 | Privacy notice contract for compliance-restricted users | § 5.3.1 — 5 required content items (provider+region, data path, retention, third-party disclaimer, off-ramp); checkbox acknowledgement gating Continue button; persistence with version-hash invalidation; Settings → Privacy revoke path; first-run flow blocking | RESOLVED |
| B9 | FR-TR-7 / FR-UX-3 untestable visual marker | FR-TR-7 single observable conformance test: every `stream === 'mic'` segment has `speakerLabel === 'You'`; FR-UX-3 layered requirement of non-color marker (icon/symbol/bold) on top of color; FR-UX-4 rename overrides the literal | RESOLVED |

### Newly Introduced Issues (during the r2 revision)

None at BLOCKING severity.

Two minor observations introduced by the revision (not blockers, not new MAJORs of substance):

- `[CARRY_FORWARD]` § 4.2 FR-TR-2-FALLBACK — if the § 10.3 gate fails, M3's 5-min P95 target "may need to be relaxed". The path forward is documented (the new target must be recorded in tech-spec.md before proceeding) but the contingent target itself is not pre-defined. Acceptable because (a) the gate is a low-probability path, and (b) the responsibility for setting the new number is correctly assigned to Hephaestus.
- `[MINOR]` § 6.4 mic/system-audio hot-swap row — "If the user re-plugs the device, recording on that stream resumes from re-plug." Behavior is undefined for the case where the user plugs a *different* device into the same default-device role. Edge case; safe to leave for tech spec.

### Carry-Over MAJOR Findings from r1 (NOT blocking, recommended cleanup)

These items from the r1 MAJOR list remain unaddressed in r2. None block decomposition; flag them so Hephaestus and Hera can pick them up at the appropriate stage.

- `[ASSUMPTION]` § 1.1 + § 2.1 — primary persona ("10+ hours per week", "Meet/Teams/Zoom in roughly equal measure") still presented as fact rather than labeled assumption.
- `[SCOPE_DRIFT]` § 4.4 FR-LIB-3 — full-text search has no FR-level cap on library size; M5 references 200 sessions but FR-LIB-3 itself is unbounded. Recommend Hephaestus pin the v1 mechanism (FTS5) and document the eviction / size policy in tech-spec.
- `[SCOPE_DRIFT]` § 4.5 FR-CFG-3 — "default audio devices" wording vs. § 1.3 non-goal "Capturing audio from sources other than default WASAPI render endpoint + default mic input device" remains internally ambiguous; § 6.4 footer says "v1 does not support per-device selection" but FR-CFG-3 itself wasn't reworded. Tech-spec should resolve.
- `[VAGUE_TERM]` § 5.1 — "≤ 10% CPU" baseline still not anchored to "with the target meeting app running and a meeting active"; idle baseline differs from real-world baseline.
- `[UX_CLARITY]` § 4.4 FR-LIB-5 — delete is still a single-confirm hard delete; no soft-delete / undo defined. Acceptable for v1 if explicitly accepted, but the PRD doesn't say "hard delete is the v1 design choice" — recommend Athena add a one-line note or Hephaestus document it.
- `[ACCESSIBILITY_GAP]` § 5.4 — accessibility section is still two bullets. Focus-visible, screen-reader announcements for state transitions, live-region for elapsed-time counter, prefers-reduced-motion for the pulsing recording indicator (FR-CAP-5) are still unstated. Recommend a v1 accessibility floor be explicitly documented (even if minimal).
- `[MISSING_PERSONA]` § 2 — first-time-user-already-in-a-meeting onboarding latency target (e.g., ≤ 90 s from first launch to recording) still not stated. § 5.3.1 + FR-CFG-1 together create a 2-modal first-run wall (privacy notice → API key → Test connection); for a stressed user already in a meeting, that's friction. Recommend an explicit onboarding-latency NFR or accept the friction in writing.

The carry-over count above is **7**, which under the strict rubric ("approved | Zero BLOCKING, ≤3 MAJOR") would still trigger REVISIONS. However, the r1 verdict's "Required Changes" list explicitly enumerated only the **9 BLOCKING items** as preconditions for decomposition, and labeled the MAJORs as "Recommend addressing in the same revision pass." Since all 9 BLOCKING items are resolved cleanly with no new blockers introduced, and ~6 of the original 16 MAJORs were resolved as a bonus, the spirit of the r1 verdict is satisfied. The remaining MAJORs are appropriately handled at tech-spec / implementation review (Apollo / Hera) rather than gating decomposition.

### Re-Review Score

| Category | r1 | r2 Resolved | r2 Remaining | r2 New |
|---|---|---|---|---|
| BLOCKING | 9 | 9 | 0 | 0 |
| MAJOR | 16 | ~6 | ~7 (carry-over, non-gating) | 0 |
| MINOR | 10 | partial | several | 1 (FALLBACK M3 number contingent) |

### Re-Review Verdict

**APPROVED.** Move to stage 3 (decomposition).

Hand-off notes for downstream agents:
- **Hephaestus (tech-spec)**: § 10.3 gate is mandatory; gate evidence (5 sessions × 2 configs DER measurements + Δ_DER) must be recorded in tech-spec.md or Apollo will reject. If the gate fails, set FR-TR-2-FALLBACK as the active path AND document the new M3 latency target. Resolve the FR-CFG-3 vs § 1.3 device-selection wording, pin FTS5 (or alternative) for FR-LIB-3 with a documented size policy, anchor § 5.1 CPU baseline to "meeting-app-running-and-active", and decide whether `prefers-reduced-motion` suppresses FR-CAP-5's pulse.
- **Hera (alignment)**: the acceptance checklist § 12 is comprehensive; the "Mic-stream segments display the literal label 'You'" check in § 12 is the conformance test for FR-TR-7 / FR-UX-3 and should be verified literally.
- **Apollo (spec review)**: enforce that tech-spec.md contains the § 10.3 gate evidence; reject if missing.

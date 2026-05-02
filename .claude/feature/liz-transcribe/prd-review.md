# PRD Review — liz-transcribe

## Verdict: revisions

## Reviewer
Nemesis (Adversarial / Devil's Advocate review) — 2026-05-02

## Note
The canonical review document for this stage is `prd-challenge.md` (Nemesis's standard deliverable name). This `prd-review.md` exists to satisfy the pipeline verification gate that expects the file by this name; its content mirrors the verdict and required-changes summary from `prd-challenge.md`. Read `prd-challenge.md` for the full detailed findings.

## Score
- BLOCKING: 9
- MAJOR: 16
- MINOR: 10
- Total: 35

## Required Changes (Blocking)
Athena must address all 9 BLOCKING findings before this PRD moves to decomposition:

1. **Tighten metric definitions (M1, M3, M4)** — sample size, sample composition, network conditions, eligible-session definition.
2. **Resolve the chunked-diarization risk (A6)** — add a tech-spec exit gate that validates diarization quality before locking architecture, OR include "full-session upload" as an in-scope fallback path.
3. **Define error states for pause/resume (FR-CAP-8)** — at minimum: app crash during pause, device removed during pause, pause during in-flight upload.
4. **Define error states for partial-failure sessions (FR-TR-3)** — session-card status text, user notification, and re-trigger affordance.
5. **Expand failure-modes table (§ 6.4)** — ASR service outage, audio device hot-swap, Windows audio-service restart, OS lock/sleep/hibernate.
6. **Specify the privacy-notice contract** for compliance-restricted users — content requirements, persistence, acknowledgement gating.
7. **Make FR-TR-7 / FR-UX-3 testable** — pick a single, observable visual marker for mic-stream segments.

Recommend addressing all 16 MAJOR findings in the same revision pass.

## Resolution Status
Athena revised `prd.md` in revision r2 (2026-05-02). All 7 required blocking changes were addressed in-place. See `decisions.md` → "Revision Requests" section for per-finding resolution rationale and rejected alternatives.

## Source of Truth
For full finding-by-finding detail (line references, severity tags, fix recommendations), see `prd-challenge.md` in the same folder.

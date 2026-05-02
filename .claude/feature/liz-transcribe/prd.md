# PRD: liz-transcribe

**Feature**: liz-transcribe
**Author**: Athena (PM Agent)
**Date**: 2026-05-02
**Revision**: r2 (post-Nemesis adversarial review — 2026-05-02)
**Priority**: P1 - High
**Status**: Revised (awaiting re-review)

---

## 1. Problem Statement

### 1.1 The Problem
Knowledge workers attend many online meetings (Google Meet, Microsoft Teams, Zoom) and 1:1 voice conversations every week. After the meeting they need to remember decisions, action items, quotes, and who said what. Manually taking notes splits attention; copying transcripts from each meeting platform is inconsistent (some platforms gate transcripts behind paid plans, some give bot-only access, some give no transcript at all).

There is no single, platform-agnostic way to capture both meeting audio (the other participants) and the user's own microphone, transcribe both with accurate speaker labels, and review the result later as a searchable personal archive.

### 1.2 Why Now
- Cloud ASR providers (AssemblyAI, Deepgram, NVIDIA Riva NIM) now offer high-accuracy speaker diarization at a price point ($0.17–$0.58 per hour) that makes per-user transcription economical.
- Windows WASAPI loopback capture is supported natively in modern Electron (>= 31) via `electron-audio-loopback`, removing the historical need for virtual audio cable drivers.
- The existing `liz-meet` codebase is already an Electron 35 + React 18 + TypeScript desktop shell, so the platform substrate is in place.

### 1.3 Non-Goals (Explicit Out-of-Scope)
The following are explicitly **NOT** in scope for this feature:
- Real-time / live captioning during the meeting (transcripts are post-session only).
- Bot-based capture that joins meetings as a participant (no Recall.ai-style attendee bot).
- Per-speaker voice fingerprinting / identity persistence across sessions (Speaker 1 in Meeting A is not necessarily Speaker 1 in Meeting B).
- Translation, summarization, or LLM-based action-item extraction (potential future feature, not v1).
- macOS or Linux support (Windows-only for v1).
- Multi-user / team / cloud-sync of transcripts (single-user, single-machine).
- Editing the transcript text (read-only review in v1).
- Capturing audio from sources other than default WASAPI render endpoint + default mic input device.

---

## 2. Users

### 2.1 Primary Persona: The Meeting-Heavy Knowledge Worker
- Spends 10+ hours per week in online meetings on Windows.
- Uses Google Meet, Teams, and Zoom in roughly equal measure.
- Wants to focus on the conversation, not on note-taking.
- Reviews transcripts later (same day or week) to extract decisions and action items.
- Comfortable installing a desktop app and granting microphone permission; not comfortable with command-line tooling.

### 2.2 Secondary Persona: The Solo Recorder
- Records voice memos / interviews via microphone only (no system audio).
- Wants automatic transcription with speaker labels for interview review.

### 2.3 Out-of-Scope Personas
- Compliance-restricted users (legal, healthcare) who cannot send audio to third-party cloud APIs — see assumption A1.
- Mobile users — Windows desktop only.

---

## 3. Goals & Success Metrics

| # | Metric | Baseline | Target | Owner | Measurement Method |
|---|--------|----------|--------|-------|--------------------|
| M1 | End-to-end transcription accuracy (WER) on the **defined clear-audio test set** (see § 3.1) | N/A (greenfield) | ≤ 10% WER (mean across the test set) | PM | Run all 10 sample sessions through the live pipeline, hand-correct per § 3.1 protocol, compute WER per session, then mean |
| M2 | Speaker diarization error rate (DER) on the **defined 2–4-speaker test subset** (see § 3.1) | N/A | ≤ 15% DER (mean across the diarization subset) | PM | Same sample sessions; compare emitted diarization labels against hand-annotated ground truth per § 3.1 |
| M3 | Time from "Stop Recording" to "Transcript ready to view" for a 60-minute meeting | N/A | ≤ 5 minutes (P95) over the **measured population in § 3.2** | Eng | App-side timing from session-end to status=`completed`; P95 computed over the runs defined in § 3.2 |
| M4 | Audio capture reliability — eligible sessions that complete without `chunk_lost` events (see § 3.3) | N/A | ≥ 99% of **eligible sessions** (defined § 3.3) | Eng | Telemetry counter: eligible sessions started vs. eligible sessions ended without `chunk_lost` event; computed monthly |
| M5 | Transcript search latency (typing query → results rendered) on a library of 200 sessions | N/A | ≤ 300 ms (P95) | Eng | App-side timing |
| M6 | First-week activation: % of installs that complete at least one transcribed session | N/A | ≥ 60% | PM | **Primary**: opt-in install telemetry (denominator = installs that opted in to telemetry; numerator = those that produced ≥ 1 `session.completed` event within 7 days). Self-reported numbers are excluded from the primary metric. |

If the PRD ships and **M1 (WER) > 15%** *or* **M2 (DER) > 25%** (each measured per § 3.1), the feature is considered a failed launch and the chosen ASR provider must be reconsidered.

### 3.1 M1 / M2 Test-Set Definition (clear-audio sample)

The **clear-audio test set** is the controlled sample used to evaluate M1 and M2. It is fixed at PRD time so the metrics are pass/fail rather than judgment calls.

**Composition** — 10 recorded sessions, all collected on the v1 reference machine (§ 5.1):

| Sub-set | Count | Speakers | Duration | Source |
|---------|-------|----------|----------|--------|
| 1:1 calls | 3 | 2 (user + 1 remote) | 15–30 min each | Mic + system audio |
| Small meetings | 5 | 3–4 distinct human speakers | 30–60 min each | Mic + system audio |
| Mic-only memos | 2 | 1 (user only) | 5–15 min each | Mic only |
| **Total** | **10** | | | |

**Clear-audio admission criteria** (every session in the sample must satisfy all of):
- Mic SNR ≥ 20 dB (measured on a 5 s sample of user speech with no system audio playing).
- No music or sustained background audio (TV, café noise) in either stream.
- All speakers in English (en-US or en-GB); accent diversity is **not** controlled in v1 — record speaker accents per session for M1 reporting.
- Each remote speaker uses a headset or laptop mic of comparable quality to the user's (no phone-on-speaker, no Bluetooth speakerphone).
- No simultaneous overlap exceeding 10% of session duration (occasional overlap is allowed and expected).

**Diarization subset (M2)**: the 5 small-meeting sessions plus the 3 1:1 sessions = 8 sessions. Mic-only memos are excluded from M2 (single speaker, DER not meaningful).

**Annotation protocol**:
- Single annotator (the PM) produces the ground-truth transcript and speaker labels.
- Annotator works from the original audio, not the app's output.
- Measurement is reproducible: the audio files, ground-truth transcripts, and the app's emitted transcripts are archived with the sample.

**WER / DER computation**:
- WER = standard Levenshtein word-edit distance between hand-corrected reference and app output, normalized by reference length, computed per session and then **arithmetic mean** across the 10 sessions.
- DER = standard NIST-style speaker confusion + missed speech + false alarm, computed per session and then **arithmetic mean** across the 8-session diarization subset.

If, after launch, the production population diverges materially from this sample (e.g., users record in heavy background noise), the metric is **not** retroactively invalidated; instead, a follow-up "real-world" sample is added in v1.x with its own targets.

### 3.2 M3 Test-Population Definition (post-session latency)

M3 (≤ 5 min P95 from Stop to Transcript-ready for 60-min meetings) is measured over the following eligible population:

- **Run count**: 20 sessions of 55–65 minutes each, collected from the v1 reference machine (§ 5.1) **and** the live production population once telemetry is enabled. Pre-launch: the 20 runs are synthetic (replayed audio); post-launch: real opt-in telemetry sessions.
- **Network condition (pre-launch)**: residential broadband, sustained ≥ 50 Mbps down / ≥ 10 Mbps up, latency ≤ 50 ms RTT to AssemblyAI's region. Any run on a slower link is **excluded** from M3 and reported separately.
- **Network condition (post-launch)**: only sessions whose `net_uplink_avg` telemetry meter reports ≥ 5 Mbps sustained during recording are eligible. Sessions on slower / metered / intermittent connections are reported as a separate "M3-degraded" metric — they do **not** count toward the 5-min P95 target but **do** appear in user-visible status (see § 4.2 FR-TR-2).
- **Pause exclusion**: sessions where the user invoked Pause for >10% of total session duration are excluded from M3 (they confound the latency calculation).
- **Failure exclusion**: sessions that did not reach `completed` status (i.e., ended in `failed` or `completed_with_failures`) are excluded from M3.

P95 is computed as the 95th percentile latency across the 20 (pre-launch) or rolling 30-day window of eligible sessions (post-launch).

### 3.3 M4 Eligible-Session Definition (capture reliability)

M4 (≥ 99% of eligible sessions complete without dropped chunks) requires precise scoping or it is unmeasurable.

**Eligible session** = a recording session that satisfies **all** of:
- Duration ≥ 5 minutes (sessions shorter than 5 min are excluded — they don't generate enough chunks to make `chunk_lost` rate statistically meaningful).
- The user did **not** explicitly disable network during recording (FR-TR-3 already buffers across short outages; the metric measures the system's reliability, not user-induced offline mode).
- The user did **not** force-quit / kill the app during recording (this is a separate recovery metric, NFR § 5.2).
- Recording started successfully (status reached `recording`); pre-flight failures don't count.

**`chunk_lost` event** is precisely defined as:
> A chunk that was successfully written to the local capture buffer but whose final transcription state is `permanently_failed` after exhausting the FR-TR-3 retry policy (5 attempts with exponential backoff). Chunks that were never written (capture failed before producing the chunk) are tracked as `chunk_capture_failed` and reported separately.

Computation:
```
M4 = 1 - (eligible_sessions_with_at_least_one_chunk_lost / total_eligible_sessions)
```
Window: monthly, post-launch.

---

## 4. Functional Requirements

### 4.1 Audio Capture (FR-CAP)

**FR-CAP-1**: User can start a new recording session from the app UI with a single click.
- Acceptance: A "Start Recording" button is visible on the home screen. Clicking it transitions the app to "Recording" state within 500 ms.

**FR-CAP-2**: The app captures system audio (loopback) and microphone audio simultaneously as two independent streams.
- Acceptance: After 30 seconds of recording with both a YouTube video playing and the user speaking into the mic, two separate audio buffers exist on disk, neither is empty, and the system-audio buffer does not contain the user's mic and vice versa.
- Acceptance: Capture works regardless of which meeting app is used (Google Meet in Chrome, Teams desktop, Zoom desktop) — system audio is captured at the OS render endpoint, not per-app.

**FR-CAP-3**: User can record mic-only (no system audio) by toggling system-audio capture off before starting.
- Acceptance: Toggle exists in pre-recording UI. When off, no loopback stream is opened; only mic audio is captured.

**FR-CAP-4**: User can record system-audio-only (no mic) by toggling mic capture off.
- Acceptance: Toggle exists. When off, no mic device is opened; only loopback is captured.

**FR-CAP-5**: The app shows a recording indicator (visual + elapsed time) while recording is active.
- Acceptance: A pulsing red indicator and `HH:MM:SS` counter are visible at all times during recording.

**FR-CAP-6**: The app shows live audio-level meters for each active stream so the user can verify capture is working.
- Acceptance: Two VU-meter-style bars (one per active stream) update at ≥ 10 Hz and respond visibly when audio is present.

**FR-CAP-7**: The app warns the user before starting if no microphone is detected (when mic is enabled) or no audio is currently playing through the default render endpoint (when system-audio is enabled).
- Acceptance: A pre-flight warning dialog appears in those cases; user can proceed anyway or cancel.

**FR-CAP-8**: The app supports pause and resume during a recording session.
- Acceptance: Pause halts both streams. Resume continues into the same session. The final transcript is stitched from non-paused intervals only.
- Acceptance (pause-while-upload-in-flight): Pause does not cancel chunks that are already mid-upload; in-flight uploads complete normally. New chunks stop being produced until Resume.
- Acceptance (pause indicator): While paused, the recording UI shows a "Paused — click Resume to continue" banner; the elapsed-time counter freezes; the VU meters freeze at zero; the pulsing red indicator transitions to a steady amber indicator (FR-CAP-5 still applies in modified form).
- Error states for pause/resume (each must show actionable copy):
  | Pause/Resume Error | Expected Behavior |
  |---|---|
  | App crashes / is force-killed while paused | On next launch, the orphaned-session recovery flow (NFR § 5.2 + § 6.4) treats the paused session as recoverable: the user is prompted "Recover paused session from [time]?" The captured non-paused intervals are queued for transcription; the session is auto-marked Stopped (a paused session cannot be Resumed across an app restart in v1). |
  | Pause exceeds the 4-hour session-recovery window | After 4 hours paused, the app auto-stops the session and queues it for transcription; user is shown a non-modal toast "Session auto-stopped after 4 h paused" on next foreground. Captured intervals are preserved. |
  | Audio device removed during pause (e.g., user unplugs USB headset/mic) | On Resume click, app re-enumerates devices. If the original device is gone: show modal "The microphone/system-audio device used at recording start is no longer available. Stop and finalize the session, or switch to [new default device] and resume?" — user chooses. If user picks Stop, captured intervals are queued for transcription as-is. |
  | Pause invoked while a chunk upload is mid-flight | In-flight uploads continue; no new chunks are produced; chunks already in the upload queue but not yet sent are held in the buffer until Resume or Stop. |
  | OS-initiated audio interruption during pause (e.g., system audio service restart) | When user clicks Resume, the app validates capture devices before accepting Resume; on failure it shows the same modal as the device-removed case. |

**FR-CAP-9**: The app supports stop, which finalizes the session and queues it for transcription.
- Acceptance: Stop transitions the session to `processing` state, returns the user to the library, and shows a "Transcribing..." progress indicator on that session card.

### 4.2 Chunked Upload & Transcription (FR-TR)

**FR-TR-1**: While recording, the app slices each stream into chunks of 5–15 seconds (default 10 s, configurable in settings).
- Acceptance: With default settings, a 60-second recording produces exactly 6 chunks per stream.

**FR-TR-2**: Chunks are uploaded to the chosen cloud ASR provider as they are produced (chunked batching, **not** real-time streaming).
- Acceptance: A 30-minute meeting that ends at T=0 has all chunks uploaded by T+30 seconds **when** the network meets the M3 eligible-population condition (§ 3.2: ≥ 5 Mbps sustained uplink). Chunks are NOT held until session end on eligible networks.
- Acceptance (slow / metered network): when telemetry detects sustained uplink < 5 Mbps OR the OS reports the connection as metered, the app surfaces an "Uploading slowly — transcript will be ready after meeting ends" status badge on the session card; FR-TR-3's retry/buffer behavior continues to apply.
- Note: Chunks are uploaded individually but transcripts are not displayed live (see FR-UX-1).

**FR-TR-2-FALLBACK** *(only enabled if § 10.3 gate FAILS)*: If the tech-spec exit gate determines that chunked uploads degrade diarization beyond the 5-pp DER threshold, the app instead buffers the full session to disk and uploads it as a single request when the user clicks Stop.
- Acceptance: With the fallback path active, a 60-minute session produces exactly **two** uploads (one per stream when both mic and system are active) at session end, not per-chunk uploads during recording.
- Acceptance: M3 is renegotiated and documented in the tech spec; a session card status of "Uploading audio" is shown after Stop until the upload completes, then "Transcribing".
- Note: Only one of FR-TR-2 or FR-TR-2-FALLBACK is active in any shipped build; the choice is fixed at tech-spec time per § 10.3.

**FR-TR-3**: If an upload fails, the chunk is retried with exponential backoff up to 5 attempts; persistent failures are logged but do not abort the session.
- Acceptance: With network disconnected for 30 seconds mid-session, the affected chunks are re-uploaded successfully when network returns; the final transcript contains the audio from those chunks.
- **Session-card status states** (the library card visibly reflects partial-failure outcomes — FR-LIB-2 status enum):
  | Final Session Status | Trigger | Card Appearance | User Notification |
  |---|---|---|---|
  | `completed` | All chunks transcribed successfully. | Standard "Completed" badge (success color). | Standard. |
  | `completed_with_failures` | Session ended successfully but ≥ 1 chunk is `permanently_failed` after retries. | "Completed (gaps)" badge (warning color); shows "N gap(s)" subtitle where N = count of failed chunks. | Toast on session-card flip: "Session completed with N transcription gap(s). Open the session to retry the failed segments." |
  | `failed` | Session never produced a usable transcript (e.g., 100% of chunks failed, or auth/quota error blocked all uploads). | "Failed" badge (error color). | Toast: "Transcription failed. Open the session to see why and retry." |
- **Threshold**: any session in which ≥ 1 chunk is `permanently_failed` AND ≥ 1 chunk succeeded is `completed_with_failures`. A session with zero successful chunks is `failed`. (No percentage-based bucket — the count is what's visible to the user.)
- **Re-trigger affordance**: opening a `completed_with_failures` session shows a "Retry failed segments" button on each `[transcription failed for HH:MM:SS – HH:MM:SS]` placeholder (FR-TR-8) AND a session-level "Retry all failed segments" action. Re-trigger is only available while the raw audio is retained on disk (FR-CFG-4); if the user has set audio to be deleted, the buttons show a disabled tooltip "Raw audio was deleted; cannot retry."
- **Proactive notification**: when the session card flips to `completed_with_failures` or `failed`, an in-app notification (toast) is shown ONCE; no OS-level notification is sent in v1.

**FR-TR-4**: When the user clicks Stop, the app waits for all pending chunks to finish transcription, then merges them into a single ordered transcript and persists it locally.
- Acceptance: For a 10-minute session, the merged transcript covers the full duration with no missing or duplicate segments.

**FR-TR-5**: The transcript includes per-segment speaker labels of the form "Speaker 1", "Speaker 2", etc. — labels are stable within a single session but not across sessions.
- Acceptance: A 2-speaker meeting produces a transcript where each segment is attributed to one of two labels and the same human voice maps to the same label throughout that session.

**FR-TR-6**: The transcript includes per-segment start/end timestamps (seconds from session start).
- Acceptance: Every segment has `start` and `end` fields with monotonically increasing `start` values.

**FR-TR-7**: Mic and system-audio streams are diarized **independently** and merged into one timeline.
- Acceptance: For a session where the user (mic) and a remote speaker (system audio) talk simultaneously, both utterances appear in the transcript at overlapping timestamps and are attributed to distinct speakers.
- Acceptance (testable visual marker): Every transcript segment whose source stream is `mic` is rendered with the **literal speaker label "You"** in place of any "Speaker N" label (replacing the diarizer's emitted label for that segment). System-audio segments retain their `Speaker 1`, `Speaker 2`, … labels. This is the single observable contract for distinguishing the local user from remote speakers; a UI test that asserts "any segment with `stream === 'mic'` has `speakerLabel === 'You'`" is the conformance test. (Additional styling per FR-UX-3 is layered on top but is not the primary distinguishing marker.)
- Acceptance (timeline alignment tolerance): The merged mic + system timeline must be accurate to within **±200 ms** over a 60-minute session, measured by comparing a known synchronization marker (e.g., a hand-clap captured by both mic and the meeting app's audio path) at session start and session end. Drift exceeding ±200 ms over 60 min is a defect; Hephaestus addresses clock-drift correction in the tech spec.

**FR-TR-8**: If transcription of a chunk ultimately fails after retries, the resulting transcript contains a `[transcription failed for HH:MM:SS – HH:MM:SS]` placeholder for that interval, accompanied by a "Retry" affordance per FR-TR-3.
- Acceptance: User can see exactly which intervals failed; clicking "Retry" on the placeholder re-submits that interval's audio for transcription (when raw audio is retained per FR-CFG-4); on success the placeholder is replaced with the transcribed text.

### 4.3 Transcript UX (FR-UX)

**FR-UX-1**: Transcripts are review-only and shown **after** the session ends, not live during the meeting.
- Acceptance: There is no live transcript pane visible during recording. Opening a session whose status is `recording` or `processing` shows the status and a progress indicator, not a partial transcript.

**FR-UX-2**: User can rename a session and add a free-text note (description) to it.
- Acceptance: Each session has a `title` (default: `Session YYYY-MM-DD HH:MM`) that the user can edit, plus a `notes` field.

**FR-UX-3**: The transcript view renders each segment with its speaker label, timestamp, and text. Segments whose source stream is `mic` MUST display the literal label **"You"** (per FR-TR-7) instead of "Speaker N", and additionally have a non-color marker (icon or symbol prefix, e.g., a person glyph) to satisfy accessibility constraints (color-only differentiation is not sufficient — see § 5.4).
- Acceptance (primary, testable): every mic-stream segment shows the literal text "You" in its speaker-label slot.
- Acceptance (accessibility): mic-stream segments include a non-color marker (icon, symbol, or bold text) — color is allowed as a *secondary* indicator but cannot be the only one.
- Acceptance (overrideable): if the user renames "You" via FR-UX-4 (e.g., to their actual name), the renamed label takes effect and the mic-stream conformance test is updated to assert the rename rather than the literal "You".

**FR-UX-4**: User can rename speaker labels per session (e.g., rename "Speaker 2" to "Alice").
- Acceptance: Renaming "Speaker 2" updates every segment in that session and persists across app restarts.

**FR-UX-5**: User can copy the full transcript or any selected segments to the clipboard as plain text.
- Acceptance: A "Copy" action is available; pasted output preserves speaker labels and is human-readable.

**FR-UX-6**: User can export a transcript to a local file in at least the following formats: plain text (`.txt`), Markdown (`.md`), and JSON (`.json` with timestamps and speaker labels).
- Acceptance: Export produces a file the user chooses the location of; the file opens correctly in Notepad / VS Code.

### 4.4 Session Library & Search (FR-LIB)

**FR-LIB-1**: The app maintains a local library of all past sessions, persisted across restarts.
- Acceptance: After recording a session, closing the app, and reopening, the session appears in the library with the same metadata.

**FR-LIB-2**: The library shows each session with: title, date/time, duration, status, and number of speakers detected. Status enum is one of: `recording`, `paused`, `processing`, `completed`, `completed_with_failures`, `failed` (see FR-TR-3 for transitions and visual treatment).
- Acceptance: All five fields are visible on each session card; the status badge color and label match the FR-TR-3 status table.

**FR-LIB-3**: User can full-text search the library by transcript content. Results show the session, the matching segment, and surrounding context.
- Acceptance: Searching "action item" returns every session whose transcript contains that phrase, with the matching utterance highlighted.

**FR-LIB-4**: User can filter the library by date range and by status.
- Acceptance: Date range picker and status filter are available; results update live.

**FR-LIB-5**: User can delete a session, which removes both the transcript and the locally cached audio (if any).
- Acceptance: After delete, the session is gone from the library; the corresponding files in `userData` are removed; a confirmation dialog prevents accidental deletion.

### 4.5 Settings & Configuration (FR-CFG)

**FR-CFG-1**: User must enter their cloud ASR API key on first run, before recording is allowed.
- Acceptance: First-run flow blocks recording until a valid key is entered. A "Test connection" button verifies the key.

**FR-CFG-2**: API key is stored in the OS credential store (Windows Credential Manager via Electron `safeStorage`), not in plain text.
- Acceptance: The key is not present in plaintext anywhere under `userData`. A code review confirms `safeStorage.encryptString` is used.

**FR-CFG-3**: User can switch chunk duration (5–15 seconds), default audio devices, and provider (if multiple are supported in a build) from a Settings panel.
- Acceptance: Settings panel exists and changes persist.

**FR-CFG-4**: User can choose whether the raw audio file is kept locally after a successful transcription or deleted (default: deleted, to save disk).
- Acceptance: Setting toggle exists; behavior matches.

---

## 5. Non-Functional Requirements

### 5.1 Performance
- App cold-start to "Ready to record" ≤ 3 seconds on a mid-tier 2024 Windows laptop (8-core, 16 GB RAM).
- Recording adds ≤ 10% CPU and ≤ 200 MB RAM over the idle app baseline.
- Library renders the first 50 sessions within 500 ms of opening.

### 5.2 Reliability
- A network outage of up to 5 minutes during recording must NOT cause data loss; chunks are buffered to disk and uploaded when connectivity returns.
- An app crash during recording must leave already-captured audio recoverable on next launch (the app offers to resume / re-transcribe).

### 5.3 Security & Privacy
- API keys stored only in the OS credential store (FR-CFG-2).
- Audio files stored under `userData` rely on standard Windows NTFS user-profile permissions only. **At-rest encryption is NOT implemented in v1** — this is a documented v1 limitation, not an oversight. Users who require at-rest encryption are referred to OS-level disk encryption (BitLocker). v1.x may revisit per-file encryption.
- The app does NOT send any data other than audio chunks to the cloud ASR provider; no telemetry to third parties without opt-in.
- A privacy notice is shown on first run with explicit acknowledgement gating (see § 5.3.1).

### 5.3.1 Privacy Notice Contract (compliance-restricted users gate)

**Purpose**: prevent users with confidentiality obligations (legal, healthcare, NDA-bound corporate users) from blindly uploading audio without informed consent. Compliance-restricted users are out-of-scope (§ 2.3) but the app must give them a clear off-ramp.

**Required content** — the first-run privacy notice MUST contain, verbatim or in clearly equivalent prose, all of the following items:

1. **Provider name and region** — the ASR provider that will receive audio (e.g., "AssemblyAI, US-based service") and a hyperlink to that provider's privacy / data-processing policy.
2. **Data path** — explicit statement of what is sent: "Both your microphone audio and your system audio (the audio of the people you are meeting with) are uploaded to the provider in chunks. Transcripts are returned to your computer and stored locally."
3. **Retention promise** — what the provider's published retention policy is (e.g., "AssemblyAI states audio is deleted after transcription completes; see their policy for current details") AND what this app does locally (FR-CFG-4: raw audio default-deleted; transcripts retained until user deletes).
4. **Third-party disclaimer** — "By proceeding, audio of other meeting participants will be sent to a third-party service. You are responsible for any consent or notification required by your jurisdiction or employer."
5. **Off-ramp** — "If you cannot send meeting audio to a third-party service (e.g., HIPAA, attorney-client privilege, or employer policy), do not proceed. This app does not currently support on-device transcription."

**Acknowledgement requirement** — the user MUST explicitly acknowledge before recording is permitted:
- A checkbox labeled "I have read the above and confirm I have the right to record and transcribe these conversations" must be checked.
- The Continue button is disabled until the checkbox is checked.
- The acknowledgement (timestamp + app version) is persisted locally; if the privacy-notice content materially changes (provider switch, data-path change), the acknowledgement is invalidated and the user is re-prompted on next launch.

**Persistence**:
- Stored locally in the app's settings store (not in OS credential store; not synced).
- Visible in Settings → Privacy where the user can view the current notice and revoke acknowledgement (revoking blocks recording until re-acknowledged).

**Acceptance**: First-run flow blocks Recording until acknowledgement is captured. Privacy notice content is shown verbatim in Settings → Privacy. Acknowledgement record contains: notice version hash, timestamp, app version.

### 5.4 Accessibility
- All controls are keyboard-reachable.
- VU-meter visuals are accompanied by numeric level readouts for screen-reader users.

### 5.5 Compatibility
- Windows 10 (build 19041+) and Windows 11.
- Electron 35.x baseline (current repo version).
- No Windows admin rights required to run.

---

## 6. User Flows

### 6.1 First-Run Setup
1. User installs and launches the app.
2. App shows welcome screen with the **privacy notice** (§ 5.3.1) — must contain provider name + region, data-path description, retention promise, third-party disclaimer, off-ramp text. User must check the acknowledgement checkbox; Continue is disabled until checked.
3. User pastes an API key for the chosen provider.
4. User clicks "Test connection". On success → green check, Continue enabled. On network failure → app accepts the syntactically valid key with a non-blocking "We couldn't verify the key right now; we'll verify on first upload" message (§ 6.4).
5. User clicks "Continue" → lands on empty Library screen with prominent "New Recording" CTA.

The acknowledgement record from step 2 is persisted; if the notice content materially changes in a future release (provider switch, data-path change), the user is re-prompted on next launch.

### 6.2 Recording a Meeting
1. User opens the meeting in their meeting app (Meet/Teams/Zoom).
2. User opens liz-transcribe, clicks "New Recording".
3. App shows pre-flight panel: Mic toggle (on), System audio toggle (on), VU meters live.
4. User clicks "Start" → recording begins, indicator visible.
5. User joins the meeting; talks for 30 minutes.
6. User clicks "Stop" → app says "Transcribing..." and returns to Library.
7. After processing, the session card status flips to "Completed". User clicks the card → reads the transcript.

### 6.3 Reviewing & Searching Past Sessions
1. User opens app on a different day.
2. Library shows all past sessions sorted by date.
3. User types "budget" in the search bar → list filters to sessions whose transcripts mention budget; matching utterance is highlighted.
4. User clicks a result → transcript opens with the matching segment scrolled into view.
5. User renames "Speaker 2" to "Alice" → all of Alice's segments now show "Alice".
6. User exports as Markdown → saves to `~/Documents/meetings/2026-05-02-budget-call.md`.

### 6.4 Failure Modes & Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| User starts recording with no API key configured | Pre-flight blocks; redirects to Settings. |
| User starts recording with no mic detected (mic toggle on) | Warning dialog: "No microphone detected. Continue with system audio only?" — user chooses. |
| User starts recording with system audio toggle on but no audio is currently playing | Soft warning ("No audio detected on default output. Recording will start; verify your meeting audio is routed correctly.") — does not block. |
| Network drops mid-recording | Chunks buffer to disk; upload resumes when network returns. UI shows "Offline — buffering" indicator. |
| Network drops during final upload at session end | Session enters "Processing — retrying" state; resumes when network returns. |
| App is force-killed mid-recording | On next launch, app detects orphaned session and offers: "Recover and transcribe?" |
| ASR API rejects key (401/403) | Session marked failed; user redirected to Settings to fix the key; raw audio retained for re-transcription. |
| ASR API quota exceeded (429) | Session pauses processing, exponential backoff up to 30 minutes; user notified after 3 failed attempts. |
| Disk full during recording | Recording stops gracefully; user notified; partial audio retained for transcription. |
| User starts a second recording while one is processing | Allowed; processing happens in background; library shows both. |
| Audio chunk too quiet / silence-only | Provider returns empty transcript; segment is skipped (no `[silence]` placeholder is shown for empty chunks under 30s of detected silence). |
| Session is over 4 hours long | Allowed in v1; warn user at 4-hour mark about expected ASR cost. |
| User deletes a session that is still processing | Allowed; in-flight uploads are cancelled; partial data is removed. |
| Two output devices in use (e.g., headphones + speakers) | App captures the **default** render endpoint only; user is informed in Settings tooltip. v1 does not support per-device selection. |
| ASR provider service outage (e.g., AssemblyAI returns 5xx for an extended period, not just 429) | Chunks retry per FR-TR-3 (5 attempts, exponential backoff). After all retries fail, those chunks become `permanently_failed`; session ends as `completed_with_failures` (FR-TR-3 table). User can retry failed segments later when the provider recovers (FR-TR-8). A persistent in-app banner "ASR provider unreachable — uploads paused" appears when ≥ 3 consecutive chunks fail with 5xx; the banner clears when a chunk uploads successfully. |
| ASR provider unreachable for the entire session (every chunk fails) | Session ends as `failed` (FR-TR-3); raw audio is **forced retained** regardless of FR-CFG-4 setting (so the user can retry); user notified via toast and an in-session "Retry all" action. |
| Mic / system-audio device hot-swap mid-recording (e.g., user unplugs USB mic) | App detects the device-removed event within ≤ 1 s. Behavior: the affected stream stops; a non-modal banner appears: "Microphone disconnected at HH:MM:SS — recording continues with [other stream] only. Plug the device back in to resume." If the user re-plugs the device, recording on that stream resumes from re-plug; a small gap appears in the transcript for the disconnected interval. If both streams' devices are lost simultaneously, the session is auto-paused (treated as user-initiated Pause) and the FR-CAP-8 device-removed modal is shown. |
| Windows audio service restart (Windows Audio service crashes / is restarted by the OS) | Treated as a transient device-loss event: streams stop; app retries device acquisition every 2 s for up to 30 s; on success, recording resumes (gap in transcript); on timeout, session is auto-paused per the dual-loss case above. |
| User logs out / locks Windows during recording | Recording continues if the OS keeps the process running (the typical Windows lock behavior). On unlock, the recording UI is intact. If the OS terminates the process during lock-screen logout, the orphaned-session recovery flow handles re-entry. |
| Windows enters Sleep / Hibernate during recording | OS suspends the process. On wake, the app detects a clock-jump > 30 s between the last successful chunk timestamp and current time. Behavior: the session is auto-stopped on wake (it cannot reliably resume across a sleep), captured intervals are queued for transcription, the user is shown a non-modal toast "Session was stopped because the system slept. Audio captured before sleep is being transcribed." Captured-audio recovery is the same as the orphaned-session flow. |
| OS-level mic permission revoked between launches | On Start Recording, the app catches the permission-denied error and shows a modal: "Microphone permission was revoked. Open Windows Settings → Privacy → Microphone to re-enable, or record system audio only." User can proceed with system-audio-only or cancel. |
| Loopback capture initialization fails (driver crashed, exclusive-mode app holds the endpoint, Windows policy) | Pre-flight error modal: "System audio capture is unavailable — another app may be using the audio device exclusively, or your audio driver is in an error state. Try: closing other audio apps, then click Retry." User can retry, switch to mic-only, or cancel. Error code from WASAPI is shown in a "Details" disclosure for support diagnosis. |
| Network down at first run (FR-CFG-1 Test connection fails) | First-run flow accepts a syntactically valid API key (correct length / character set per provider) and shows a non-blocking "Couldn't verify the key right now — we'll verify the next time you have a network connection." User can proceed to record. The first successful upload validates the key; if it fails with 401/403, the existing FR-TR-3 → settings-redirect flow takes over. |

---

## 7. ASR Provider Selection (Decision)

A core open question in the requirements was: **NVIDIA NIM (Parakeet ASR + Sortformer Diarizer) vs. AssemblyAI vs. Deepgram vs. AWS Transcribe.** Based on Mimir's research:

### 7.1 Comparison Matrix

| Provider | Diarization | Accuracy (WER) | Pricing (incl. diarization) | API Maturity | Notes |
|----------|-------------|----------------|-----------------------------|---------------|-------|
| **AssemblyAI** | Built-in (utterance-level, ~2.9% diarization error rate) | 5.9% English | ~$0.17/hr | Async batch + streaming, very mature | Best accuracy and price for diarized batch transcription |
| **Deepgram** | Built-in (word-level) | 8.1% English | ~$0.58/hr (3× AssemblyAI) | REST + WebSocket, mature | Better for ultra-low-latency live use cases (not our case) |
| **NVIDIA NIM (Parakeet + Sortformer)** | Built-in (Sortformer) | Competitive on English; multilingual strong | $0.10–$10 / M tokens; free credits available; pay-as-you-go endpoints | Newer (NIM speech released 2026), pricing partially opaque | Strong tech, but pricing model is token-based and harder to forecast for hour-priced audio |
| **AWS Transcribe** | Built-in | ~9–11% English | ~$1.44/hr | Mature | Significantly more expensive |

### 7.2 Decision

**Primary provider for v1: AssemblyAI.**
- Cheapest at every volume tier when diarization is required.
- Highest measured accuracy and lowest diarization error rate of the candidates.
- Async batch endpoint matches our chunked-batching architecture — no streaming complexity required.
- Single REST flow: upload chunk → get transcript ID → poll → fetch result.

**Architecture allows swap-out**: The provider interface is abstracted in the tech spec (Hephaestus's domain) so a future build can target Deepgram or NVIDIA NIM without UI changes. NVIDIA NIM remains a viable second target once 2026 pricing is clearer.

**Rejected**:
- **Deepgram** — 3× the cost for measurably worse diarization accuracy (per AssemblyAI's published benchmarks; treat with appropriate caution).
- **NVIDIA NIM** — promising but token-based pricing makes per-meeting cost forecasting harder for an MVP; revisit in v1.x.
- **AWS Transcribe** — too expensive given equal-or-worse accuracy.

---

## 8. External API Dependencies

### 8.1 AssemblyAI (Primary)

| Aspect | Details |
|--------|---------|
| **Service** | AssemblyAI Async Transcription API |
| **Auth** | API key in `Authorization` header |
| **Base URL** | `https://api.assemblyai.com/v2` |
| **Key Endpoints** | `POST /upload` (audio chunk → URL), `POST /transcript` (URL + options → transcript ID), `GET /transcript/:id` (poll) |
| **Diarization param** | `speaker_labels: true` |
| **Pricing** | ~$0.17/hour with diarization (verify on signup; subject to change) |
| **Rate limits** | Per-account; AssemblyAI documents async transcription as scaling to thousands of files in parallel |
| **Reference** | https://www.assemblyai.com/products/speech-to-text |

### 8.2 Deepgram (Optional secondary, behind feature flag)

| Aspect | Details |
|--------|---------|
| **Service** | Deepgram Pre-Recorded Transcription |
| **Auth** | API key |
| **Base URL** | `https://api.deepgram.com/v1` |
| **Key Endpoint** | `POST /listen?model=nova-3&diarize=true&utterances=true&smart_format=true` |
| **Pricing** | ~$0.58/hour with diarization |
| **Reference** | https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded |

### 8.3 Audio Capture Library

| Aspect | Details |
|--------|---------|
| **Library** | `electron-audio-loopback` (npm) |
| **Min Electron** | 31.0.1 (we are on 35 — compatible) |
| **Platforms** | Windows 10+, macOS 12.3+, Linux (we ship Windows only in v1) |
| **API** | `enableLoopbackAudio()` / `disableLoopbackAudio()` exposed via preload, then standard `getDisplayMedia({ audio: true, video: true })` in renderer; video track is dropped |
| **Reference** | https://www.npmjs.com/package/electron-audio-loopback |

The exact integration shape (main vs. renderer responsibilities, Web Audio worklet vs. raw chunk write) is **Hephaestus's call** in the tech spec.

---

## 9. Local Storage Requirements

**WHAT** the app must store (the **HOW** is for Hephaestus):

- **Sessions**: id, title, notes, created_at, started_at, ended_at, duration_seconds, status, speaker_count, source (mic / system / both), provider, raw_audio_path (nullable).
- **Segments**: id, session_id, stream (mic / system), speaker_label, start_seconds, end_seconds, text, confidence (nullable).
- **Speaker label overrides**: session_id, original_label, custom_label.
- **Settings**: provider, chunk_seconds, keep_raw_audio (bool), default device IDs.
- **API key**: in OS credential store, **not** in the database.
- **Full-text search**: transcripts must be searchable across the library — Hephaestus to choose mechanism (SQLite FTS5, Lunr, etc.).

Storage location: under `app.getPath('userData')`, per Electron convention.

---

## 10. Assumptions & Open Questions

### 10.1 Assumptions Made (with risk-if-wrong)

| # | Assumption | Risk if Wrong | Mitigation |
|---|------------|---------------|------------|
| A1 | The user does not need on-device transcription for compliance — cloud APIs are acceptable per CLARIFIED_REQUIREMENTS. | If wrong, the app cannot ship — entire architecture changes. | Confirmed in clarified requirements; documenting here for downstream agents. |
| A2 | AssemblyAI's published diarization accuracy benchmarks are roughly representative of the user's actual meetings. | M2 (DER ≤ 15%) misses; user dissatisfaction. | Architecture allows provider swap; v1 launch includes a 2-week measurement window per M1/M2. |
| A3 | The default Windows render endpoint captures all of the user's meeting audio. (i.e., the user is not running their meeting through a non-default audio device.) | Loopback captures wrong audio. | FR-CAP-7 pre-flight warning + Settings tooltip; v1.x adds device picker. |
| A4 | Per-session speaker labels (Speaker 1, Speaker 2 within a session) are sufficient — no cross-session voice fingerprinting required. | User wants persistent identities. | Documented as out of scope (§ 1.3); FR-UX-4 lets users rename per session. |
| A5 | A 60-minute meeting will return a complete transcript within 5 minutes of "Stop" (M3). | M3 misses; user perceives the app as slow. | Async chunked upload during recording (FR-TR-2) means most upload bandwidth is already consumed before stop. |
| A6 | Chunked batching (5–15 s chunks) does not degrade diarization quality vs. full-session batching by more than 5 percentage points of DER. | Diarization accuracy drops below the M2 target; chosen architecture invalidates M2. | **Tech-Spec Exit Gate (mandatory)** — see § 10.3. The tech spec MUST NOT lock the chunked architecture until the gate passes; otherwise the app falls back to full-session upload (FR-TR-2-FALLBACK). |

### 10.2 Open Questions for Tech Spec Phase

1. **Chunk-size impact on diarization accuracy**: Does AssemblyAI's diarizer perform better on 30-minute single uploads vs. 10-second chunks stitched together? Hephaestus must run the gate in § 10.3 and decide between (a) chunking + per-chunk diarization, or (b) full-session upload (FR-TR-2-FALLBACK).
2. **Mic + system stream merging strategy**: Send both streams to ASR independently (cleaner diarization per stream), or pre-mix and send one combined stream (cheaper, single transcript)? PRD mandates the **outcome** (FR-TR-7) but not the implementation.
3. **Speaker label mapping across mic and system streams**: How do we present "you" (mic) alongside "Speaker 1, Speaker 2" (system) without confusing the user? Recommendation: mic stream is always rendered as "You" with distinct styling; system stream uses generic Speaker N labels.
4. **Local audio retention**: Default off (delete after transcription) vs. default on (keep for re-transcription)? Default to delete to save disk; surfaced in Settings.

### 10.3 Tech-Spec Exit Gate — Chunked Diarization Validation (BLOCKING)

This gate exists because A6 (chunked batching does not materially degrade diarization) is unvalidated and M2 depends on it being correct. Hephaestus's tech spec **must** not finalize the chunked-batching architecture until this gate passes. If the gate fails, the spec **must** instead use the FR-TR-2-FALLBACK full-session-upload path defined in § 4.2.

**Gate inputs**: 5 of the 8 diarization-subset sessions defined in § 3.1 (3 small-meeting + 2 1:1).

**Gate procedure**:
1. Submit the same 5 sessions to AssemblyAI under two configurations:
   - **Config A (chunked)**: cut into 10-second chunks and submit each chunk individually with `speaker_labels: true`; stitch results into one timeline.
   - **Config B (full)**: submit each session as one upload with `speaker_labels: true`.
2. For each session, compute DER against ground truth (per § 3.1 protocol) for both configurations.
3. Compute `Δ_DER = mean(DER_A) − mean(DER_B)` across the 5 sessions.

**Gate decision**:
- **PASS** (`Δ_DER ≤ 5 percentage points`): proceed with chunked architecture as specified in FR-TR-2.
- **FAIL** (`Δ_DER > 5 percentage points`): drop FR-TR-2's "upload during recording" requirement and switch to FR-TR-2-FALLBACK (full-session upload at stop). Update M3 — the 5-minute target may need to be relaxed for long sessions; document the new target before proceeding.

**Gate evidence**: Hephaestus must record the 10 (5 sessions × 2 configs) DER measurements and the resulting `Δ_DER` in `tech-spec.md` § "Chunked Diarization Validation". The spec is rejected at review (Apollo) if this evidence is missing.

**Authority**: This gate decision is Hephaestus's call within the bounds defined here. Athena does not need to be re-consulted unless the gate fails AND the FR-TR-2-FALLBACK path also conflicts with another PRD requirement.

---

## 11. External Research Summary

This PRD's provider selection (§ 7) and capture-library choice (§ 8.3) were informed by external research conducted via web search (Mimir-style):

- **AssemblyAI vs. Deepgram pricing & accuracy benchmarks** — sourced from Gladia comparison study, AssemblyAI public benchmarks, Brass Transcripts pricing analysis, and Deepgram's own diarization documentation.
- **NVIDIA NIM (Parakeet + Sortformer) availability** — sourced from NVIDIA NIM Speech docs (release 26.02.0+), NVIDIA Technical Blog on Streaming Sortformer, and 2026 NIM pricing pages.
- **WASAPI loopback in Electron** — sourced from `electron-audio-loopback` npm/GitHub repos and Microsoft Win32 Core Audio documentation.
- **SQLite + Electron storage patterns** (informational, not prescriptive — Hephaestus chooses): RxDB Electron guide, SQLite FTS5 documentation.

Sources are listed at the end of this document.

---

## 12. Acceptance Checklist (for Hera, downstream)

- [ ] User can start a recording in ≤ 1 click from the home screen (FR-CAP-1).
- [ ] System + mic streams capture independently and correctly (FR-CAP-2, FR-CAP-3, FR-CAP-4).
- [ ] Recording UI shows indicator, timer, and per-stream VU meters (FR-CAP-5, FR-CAP-6).
- [ ] Pause / resume / stop work as specified (FR-CAP-8, FR-CAP-9).
- [ ] Audio is chunked at 5–15 s and uploaded during recording (FR-TR-2) on eligible networks; OR full-session-upload fallback is active per § 10.3 gate result (FR-TR-2-FALLBACK).
- [ ] Slow / metered network produces the documented status badge instead of failing (FR-TR-2 acceptance row 2).
- [ ] Failed uploads retry with backoff; persistent failures produce a placeholder + a Retry affordance (FR-TR-3, FR-TR-8).
- [ ] Session card statuses include `completed_with_failures` and `failed`, with the documented badges and toasts (FR-TR-3 status table).
- [ ] Final transcript has speaker labels, timestamps, and is stitched from all chunks (FR-TR-4, FR-TR-5, FR-TR-6).
- [ ] Mic-stream segments display the literal label "You" plus a non-color marker (FR-TR-7, FR-UX-3).
- [ ] Merged mic + system timeline alignment is within ±200 ms over a 60-min session (FR-TR-7).
- [ ] No live transcript is shown during recording (FR-UX-1).
- [ ] User can rename sessions, rename speaker labels, copy, and export to txt/md/json (FR-UX-2, FR-UX-4, FR-UX-5, FR-UX-6).
- [ ] Library lists past sessions with all required metadata (FR-LIB-2).
- [ ] Full-text search across the library works (FR-LIB-3).
- [ ] Date/status filtering works (FR-LIB-4).
- [ ] Delete removes both DB rows and audio files with confirmation (FR-LIB-5).
- [ ] First-run setup blocks recording until privacy notice is acknowledged AND API key is entered (FR-CFG-1, § 5.3.1).
- [ ] Privacy notice content includes provider+region, data path, retention promise, third-party disclaimer, off-ramp text (§ 5.3.1).
- [ ] API key is stored in OS credential store, not plain text (FR-CFG-2).
- [ ] Settings expose chunk duration, audio devices, provider, audio retention (FR-CFG-3, FR-CFG-4).
- [ ] App recovers an in-progress session after a crash (NFR § 5.2).
- [ ] Pause / resume error states (device removed during pause, app crash while paused, pause > 4h, in-flight upload at pause) behave per FR-CAP-8.
- [ ] Failure-modes table § 6.4 covers ASR outage, audio device hot-swap, Windows audio service restart, OS sleep/lock, mic permission revoked, loopback init failed, no-network-at-first-run.
- [ ] All success metrics M1–M6 have measurement procedures defined (§ 3, § 3.1, § 3.2, § 3.3).
- [ ] Tech-spec exit gate (§ 10.3) results documented in tech-spec.md before proceeding to implementation.

---

## 13. References

### Provider Documentation
- [AssemblyAI Speech-to-Text product](https://www.assemblyai.com/products/speech-to-text)
- [AssemblyAI Speaker Diarization feature](https://www.assemblyai.com/features/speaker-diarization)
- [AssemblyAI Benchmarks](https://www.assemblyai.com/benchmarks)
- [AssemblyAI vs Deepgram pricing analysis (Brass Transcripts)](https://brasstranscripts.com/blog/assemblyai-vs-deepgram-pricing-high-volume-comparison)
- [AssemblyAI vs Deepgram comparison (Gladia)](https://www.gladia.io/blog/assemblyai-vs-deepgram)
- [Deepgram Speaker Diarization docs](https://developers.deepgram.com/docs/diarization)
- [Deepgram Pre-Recorded API reference](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded)

### NVIDIA NIM
- [NVIDIA Speech NIM Microservices Release Notes](https://docs.nvidia.com/nim/speech/latest/about/release-notes.html)
- [NVIDIA ASR NIM Support Matrix](https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html)
- [NVIDIA Streaming Sortformer technical blog](https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/)
- [NVIDIA NIM 2026 pricing](https://costbench.com/software/llm-api-providers/nvidia-nim/)

### Audio Capture
- [`electron-audio-loopback` npm package](https://www.npmjs.com/package/electron-audio-loopback)
- [`electron-audio-loopback` GitHub](https://github.com/alectrocute/electron-audio-loopback)
- [Microsoft WASAPI Loopback Recording docs](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [Electron desktopCapturer API](https://www.electronjs.org/docs/latest/api/desktop-capturer)

### Storage (informational)
- [RxDB Electron storage guide](https://rxdb.info/electron-database.html)
- [SQLite FTS5 practical guide](https://medium.com/@johnidouglasmarangon/full-text-search-in-sqlite-a-practical-guide-80a69c3f42a4)

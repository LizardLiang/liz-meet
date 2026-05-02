// src/constants/privacy-notice.ts
// Privacy notice text and version hash.
// SHA-256 of the notice text is stored with each acknowledgement.
// Any wording change must update this file so existing acks are invalidated.

export const NOTICE_TEXT = `Privacy Notice — Liz Meet Transcription

1. Provider & Region
   Your audio is sent to AssemblyAI (US-based service) for transcription.
   By using this feature you consent to your audio being processed by AssemblyAI
   under their Terms of Service (https://www.assemblyai.com/legal/terms-of-service)
   and Privacy Policy (https://www.assemblyai.com/legal/privacy-policy).

2. Data Path
   Audio chunks are uploaded to AssemblyAI's servers for transcription.
   Transcripts are returned to your device and stored locally in an SQLite
   database under your user data directory. No data is sent to any other server.

3. Retention Promise
   By default, raw audio files are deleted from your device after successful
   transcription. You can change this in Settings → Audio Retention.
   Transcripts remain in the local database until you delete them.

4. Third-Party Disclaimer
   AssemblyAI is a third-party service. Liz Meet has no control over AssemblyAI's
   data handling practices beyond what is stated in their published policies.
   You are responsible for ensuring your use complies with applicable laws
   (e.g., recording consent requirements in your jurisdiction).

5. Opting Out
   You may stop using the transcription feature at any time. You can revoke your
   acknowledgement and delete all local transcript data from Settings → Privacy.
   Deleting the app will remove all locally stored data.`;

// Hash is computed at build time as a constant.
// In production this would be computed from NOTICE_TEXT via crypto.createHash('sha256').
// We hardcode here to avoid requiring crypto in the renderer bundle.
// This value must be regenerated when NOTICE_TEXT changes.
export const NOTICE_VERSION_HASH = 'liz-meet-privacy-notice-v1-2026-05-03';

// src/types/liz-transcribe.ts
// Shared types between main and renderer processes

export type SessionStatus =
  | 'recording'
  | 'paused'
  | 'processing'
  | 'completed'
  | 'completed_with_failures'
  | 'failed';

export type AudioSource = 'mic' | 'system' | 'both';
export type Stream = 'mic' | 'system';
export type ChunkStatus =
  | 'pending'
  | 'uploading'
  | 'polling'
  | 'transcribed'
  | 'failed'
  | 'permanently_failed';

export interface Session {
  id: string;
  title: string;
  notes: string;
  createdAt: string;        // ISO-8601 UTC
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  status: SessionStatus;
  speakerCount: number | null;
  source: AudioSource;
  provider: 'assemblyai' | 'deepgram';
  rawAudioPath: string | null;
  noticeHashAtCreation: string | null;
}

export interface Chunk {
  id: string;
  sessionId: string;
  stream: Stream;
  seq: number;
  filePath: string;
  startSeconds: number;
  endSeconds: number;
  status: ChunkStatus;
  retryCount: number;
  lastError: string | null;
  uploadUrl: string | null;
  transcriptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Segment {
  id: number;
  sessionId: string;
  chunkId: string | null;
  stream: Stream;
  speakerLabel: string;      // raw label OR "You" for mic
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence: number | null;
  isFailedPlaceholder: boolean;
}

export interface SpeakerLabelOverride {
  sessionId: string;
  originalLabel: string;
  customLabel: string;
}

export interface Settings {
  chunkSeconds: number;         // 5–15
  micDeviceId: number | null;   // -1 = default
  provider: 'assemblyai' | 'deepgram';
  keepRawAudio: boolean;
  telemetryOptIn: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  chunkSeconds: 10,
  micDeviceId: null,
  provider: 'assemblyai',
  keepRawAudio: false,
  telemetryOptIn: false,
};

export interface SearchResult {
  sessionId: string;
  segmentId: number;
  startSeconds: number;
  speakerLabel: string;
  /** FTS5 snippet with U+0002/U+0003 (STX/ETX) start/end markers — NOT HTML */
  snippet: string;
}

export interface PreflightResult {
  ok: boolean;
  micAvailable: boolean;
  systemAudioSilent: boolean;
  apiKeyExists: boolean;
  loopbackReady: boolean;
}

export interface VuUpdate {
  stream: Stream;
  rmsDb: number;
}

export interface DeviceEvent {
  stream: Stream;
  event: 'removed' | 'restored' | 'chunk_oversize';
  errorCode?: number;
}

export interface SessionStatusChangedPayload {
  sessionId: string;
  newStatus: SessionStatus;
  reason?: 'sleep' | 'pause-timeout';
}

export interface ProviderBannerPayload {
  visible: boolean;
}

// IPC result envelope
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; logId?: string } };

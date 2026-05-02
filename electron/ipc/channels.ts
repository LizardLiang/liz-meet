// electron/ipc/channels.ts
// Central registry of all IPC channel name constants and their request/response types.
// All call sites MUST use these constants — never string literals.

import type {
  Session,
  Chunk,
  Segment,
  SessionStatus,
  AudioSource,
  SearchResult,
  PreflightResult,
  IpcResult,
  Stream,
} from '../../src/types/liz-transcribe.js';

export const CHANNELS = {
  // Session CRUD
  SESSION_LIST:   'session:list',
  SESSION_GET:    'session:get',
  SESSION_UPDATE: 'session:update',
  SESSION_DELETE: 'session:delete',
  // Capture
  CAPTURE_START:          'capture:start',
  CAPTURE_PAUSE:          'capture:pause',
  CAPTURE_RESUME:         'capture:resume',
  CAPTURE_STOP:           'capture:stop',
  CAPTURE_STATUS:         'capture:status',
  CAPTURE_PREFLIGHT:      'capture:preflight',
  CAPTURE_LOOPBACK_CHUNK: 'capture:loopback-chunk',
  // Segments
  SEGMENT_FIND_BY_SESSION: 'segment:findBySession',
  SEGMENT_SEARCH:          'segment:search',
  // Speaker labels
  SPEAKER_LABEL_UPSERT: 'speakerLabel:upsert',
  SPEAKER_LABEL_LIST:   'speakerLabel:list',
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // API key
  APIKEY_SET:    'apikey:set',
  APIKEY_EXISTS: 'apikey:exists',
  APIKEY_TEST:   'apikey:test',
  // Privacy
  PRIVACY_ACK_GET: 'privacy:get',
  PRIVACY_ACK_SET: 'privacy:set',
  PRIVACY_REVOKE:  'privacy:revoke',
  // Transcript retry
  TRANSCRIPT_RETRY_CHUNK: 'transcript:retry-chunk',
  TRANSCRIPT_RETRY_ALL:   'transcript:retry-all-failed',
  // Export
  TRANSCRIPT_EXPORT: 'transcript:export',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

// ---- Push channels (main → renderer) ----
export const PUSH_CHANNELS = {
  SESSION_STATUS_CHANGED: 'session:status-changed',
  SESSION_AUTO_STOPPED:   'session:auto-stopped',
  CAPTURE_VU_UPDATE:      'capture:vu-update',
  CAPTURE_VU_UPDATE_SYSTEM: 'capture:vu-update-system',
  CAPTURE_DEVICE_EVENT:   'capture:device-event',
  ASR_PROVIDER_BANNER:    'asr:provider-banner',
} as const;

export type PushChannelName = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS];

// ---- Request / Response type maps ----
// (Used by withErrorWrapper and renderer ipc.ts typed invoke)

export interface SessionListArgs {
  offset?: number;
  limit?: number;
  status?: SessionStatus[];
  dateFrom?: string;
  dateTo?: string;
}

export interface SessionUpdateArgs {
  id: string;
  title?: string;
  notes?: string;
}

export interface CaptureStartArgs {
  title: string;
  source: AudioSource;
}

export interface LoopbackChunkArgs {
  sessionId: string;
  seq: number;
  mimeType: string;
  buffer: ArrayBuffer;
}

export interface SegmentSearchArgs {
  query: string;
  limit?: number;
}

export interface SpeakerLabelUpsertArgs {
  sessionId: string;
  originalLabel: string;
  customLabel: string;
}

export interface SettingsGetArgs {
  key: string;
}

export interface SettingsSetArgs {
  key: string;
  value: unknown;
}

export interface ApiKeySetArgs {
  key: string;
}

export interface ApiKeyTestArgs {
  key: string;
}

export interface PrivacyAckSetArgs {
  noticeHash: string;
  appVersion: string;
}

export interface RetryChunkArgs {
  chunkId: string;
}

export interface ExportArgs {
  sessionId: string;
  format: 'txt' | 'md' | 'json';
}

// ---- Typed channel maps ---- (for withErrorWrapper generics)

export type ChannelReqMap = {
  [CHANNELS.SESSION_LIST]:   SessionListArgs;
  [CHANNELS.SESSION_GET]:    { id: string };
  [CHANNELS.SESSION_UPDATE]: SessionUpdateArgs;
  [CHANNELS.SESSION_DELETE]: { id: string };
  [CHANNELS.CAPTURE_START]:  CaptureStartArgs;
  [CHANNELS.CAPTURE_PAUSE]:  undefined;
  [CHANNELS.CAPTURE_RESUME]: undefined;
  [CHANNELS.CAPTURE_STOP]:   undefined;
  [CHANNELS.CAPTURE_STATUS]: undefined;
  [CHANNELS.CAPTURE_PREFLIGHT]: undefined;
  [CHANNELS.CAPTURE_LOOPBACK_CHUNK]: LoopbackChunkArgs;
  [CHANNELS.SEGMENT_FIND_BY_SESSION]: { sessionId: string };
  [CHANNELS.SEGMENT_SEARCH]: SegmentSearchArgs;
  [CHANNELS.SPEAKER_LABEL_UPSERT]: SpeakerLabelUpsertArgs;
  [CHANNELS.SPEAKER_LABEL_LIST]: { sessionId: string };
  [CHANNELS.SETTINGS_GET]: SettingsGetArgs;
  [CHANNELS.SETTINGS_SET]: SettingsSetArgs;
  [CHANNELS.APIKEY_SET]: ApiKeySetArgs;
  [CHANNELS.APIKEY_EXISTS]: undefined;
  [CHANNELS.APIKEY_TEST]: ApiKeyTestArgs;
  [CHANNELS.PRIVACY_ACK_GET]: undefined;
  [CHANNELS.PRIVACY_ACK_SET]: PrivacyAckSetArgs;
  [CHANNELS.PRIVACY_REVOKE]: undefined;
  [CHANNELS.TRANSCRIPT_RETRY_CHUNK]: RetryChunkArgs;
  [CHANNELS.TRANSCRIPT_RETRY_ALL]: { sessionId: string };
  [CHANNELS.TRANSCRIPT_EXPORT]: ExportArgs;
};

export type ChannelResMap = {
  [CHANNELS.SESSION_LIST]:   Session[];
  [CHANNELS.SESSION_GET]:    Session | null;
  [CHANNELS.SESSION_UPDATE]: Session;
  [CHANNELS.SESSION_DELETE]: { deleted: boolean };
  [CHANNELS.CAPTURE_START]:  { sessionId: string };
  [CHANNELS.CAPTURE_PAUSE]:  { ok: boolean };
  [CHANNELS.CAPTURE_RESUME]: { ok: boolean };
  [CHANNELS.CAPTURE_STOP]:   { ok: boolean };
  [CHANNELS.CAPTURE_STATUS]: { state: string };
  [CHANNELS.CAPTURE_PREFLIGHT]: PreflightResult;
  [CHANNELS.CAPTURE_LOOPBACK_CHUNK]: { ok: boolean };
  [CHANNELS.SEGMENT_FIND_BY_SESSION]: Segment[];
  [CHANNELS.SEGMENT_SEARCH]: SearchResult[];
  [CHANNELS.SPEAKER_LABEL_UPSERT]: { ok: boolean };
  [CHANNELS.SPEAKER_LABEL_LIST]: Array<{ originalLabel: string; customLabel: string }>;
  [CHANNELS.SETTINGS_GET]: unknown;
  [CHANNELS.SETTINGS_SET]: { ok: boolean };
  [CHANNELS.APIKEY_SET]: { ok: boolean };
  [CHANNELS.APIKEY_EXISTS]: boolean;
  [CHANNELS.APIKEY_TEST]: { ok: boolean; error?: string };
  [CHANNELS.PRIVACY_ACK_GET]: { acknowledged: boolean; content: string };
  [CHANNELS.PRIVACY_ACK_SET]: { ok: boolean };
  [CHANNELS.PRIVACY_REVOKE]: { ok: boolean };
  [CHANNELS.TRANSCRIPT_RETRY_CHUNK]: { ok: boolean };
  [CHANNELS.TRANSCRIPT_RETRY_ALL]: { queued: number };
  [CHANNELS.TRANSCRIPT_EXPORT]: { ok: boolean; path?: string; cancelled?: boolean };
};

// Push channel payload types
export interface PushChannelPayloadMap {
  [PUSH_CHANNELS.SESSION_STATUS_CHANGED]: {
    sessionId: string;
    newStatus: SessionStatus;
    reason?: 'sleep' | 'pause-timeout';
  };
  [PUSH_CHANNELS.SESSION_AUTO_STOPPED]: {
    sessionId: string;
    reason: 'sleep' | 'pause-timeout';
  };
  [PUSH_CHANNELS.CAPTURE_VU_UPDATE]: { stream: Stream; rmsDb: number };
  [PUSH_CHANNELS.CAPTURE_VU_UPDATE_SYSTEM]: { rmsDb: number };
  [PUSH_CHANNELS.CAPTURE_DEVICE_EVENT]: {
    stream: Stream;
    event: 'removed' | 'restored' | 'chunk_oversize';
    errorCode?: number;
  };
  [PUSH_CHANNELS.ASR_PROVIDER_BANNER]: { visible: boolean };
}

// Wrapped result types (used by renderer after withErrorWrapper)
export type WrappedRes<C extends ChannelName> = IpcResult<ChannelResMap[C]>;

// Chunk (used by chunk-processor)
export type { Chunk, Session, Segment, SearchResult };

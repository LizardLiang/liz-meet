// electron/db/mappers.ts
// Converts snake_case DB rows to camelCase TypeScript types.

import type {
  Session,
  Chunk,
  Segment,
  SpeakerLabelOverride,
} from '../../src/types/liz-transcribe.js';
import type { SessionStatus, AudioSource, Stream, ChunkStatus } from '../../src/types/liz-transcribe.js';

interface RawSession {
  id: string;
  title: string;
  notes: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  status: string;
  speaker_count: number | null;
  source: string;
  provider: string;
  raw_audio_path: string | null;
  notice_hash_at_creation: string | null;
}

interface RawChunk {
  id: string;
  session_id: string;
  stream: string;
  seq: number;
  file_path: string;
  start_seconds: number;
  end_seconds: number;
  status: string;
  retry_count: number;
  last_error: string | null;
  upload_url: string | null;
  transcript_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RawSegment {
  id: number;
  session_id: string;
  chunk_id: string | null;
  stream: string;
  speaker_label: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
  confidence: number | null;
  is_failed_placeholder: number;
}

interface RawSpeakerOverride {
  session_id: string;
  original_label: string;
  custom_label: string;
}

export function mapSession(row: RawSession): Session {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    status: row.status as SessionStatus,
    speakerCount: row.speaker_count,
    source: row.source as AudioSource,
    provider: row.provider as 'assemblyai' | 'deepgram',
    rawAudioPath: row.raw_audio_path,
    noticeHashAtCreation: row.notice_hash_at_creation,
  };
}

export function mapChunk(row: RawChunk): Chunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    stream: row.stream as Stream,
    seq: row.seq,
    filePath: row.file_path,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    status: row.status as ChunkStatus,
    retryCount: row.retry_count,
    lastError: row.last_error,
    uploadUrl: row.upload_url,
    transcriptId: row.transcript_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapSegment(row: RawSegment): Segment {
  return {
    id: row.id,
    sessionId: row.session_id,
    chunkId: row.chunk_id,
    stream: row.stream as Stream,
    speakerLabel: row.speaker_label,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    text: row.text,
    confidence: row.confidence,
    isFailedPlaceholder: row.is_failed_placeholder === 1,
  };
}

export function mapSpeakerOverride(row: RawSpeakerOverride): SpeakerLabelOverride {
  return {
    sessionId: row.session_id,
    originalLabel: row.original_label,
    customLabel: row.custom_label,
  };
}

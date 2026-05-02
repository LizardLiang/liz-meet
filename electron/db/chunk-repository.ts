// electron/db/chunk-repository.ts
// Typed CRUD for the chunks table.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Chunk, ChunkStatus, Stream } from '../../src/types/liz-transcribe.js';
import { mapChunk } from './mappers.js';

export interface CreateChunkInput {
  sessionId: string;
  stream: Stream;
  seq: number;
  filePath: string;
  startSeconds: number;
  endSeconds: number;
}

export class ChunkRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateChunkInput): Chunk {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO chunks
         (id, session_id, stream, seq, file_path, start_seconds, end_seconds,
          status, retry_count, created_at, updated_at)
         VALUES (@id, @sessionId, @stream, @seq, @filePath, @startSeconds, @endSeconds,
          'pending', 0, @now, @now)`,
      )
      .run({
        id,
        sessionId: input.sessionId,
        stream: input.stream,
        seq: input.seq,
        filePath: input.filePath,
        startSeconds: input.startSeconds,
        endSeconds: input.endSeconds,
        now,
      });
    return this.findById(id)!;
  }

  findById(id: string): Chunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id);
    return row ? mapChunk(row as Parameters<typeof mapChunk>[0]) : null;
  }

  /** Return up to `limit` pending chunks, oldest first */
  findPending(limit: number): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chunks WHERE status = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit);
    return rows.map(r => mapChunk(r as Parameters<typeof mapChunk>[0]));
  }

  /** Return up to `limit` in-flight chunks (uploading or polling), oldest-polled first */
  findInFlight(limit: number): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chunks WHERE status IN ('uploading','polling')
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(limit);
    return rows.map(r => mapChunk(r as Parameters<typeof mapChunk>[0]));
  }

  findBySession(sessionId: string): Chunk[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE session_id = ? ORDER BY stream, seq')
      .all(sessionId);
    return rows.map(r => mapChunk(r as Parameters<typeof mapChunk>[0]));
  }

  findFailedBySession(sessionId: string): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chunks WHERE session_id = ?
         AND status IN ('failed','permanently_failed')
         ORDER BY stream, seq`,
      )
      .all(sessionId);
    return rows.map(r => mapChunk(r as Parameters<typeof mapChunk>[0]));
  }

  findPermanentlyFailedBySession(sessionId: string): Chunk[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chunks WHERE session_id = ?
         AND status = 'permanently_failed'
         ORDER BY stream, seq`,
      )
      .all(sessionId);
    return rows.map(r => mapChunk(r as Parameters<typeof mapChunk>[0]));
  }

  updateStatus(id: string, status: ChunkStatus, lastError?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE chunks SET status = @status, last_error = @lastError, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, status, lastError: lastError ?? null, now });
  }

  incrementRetry(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE chunks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?')
      .run(now, id);
  }

  setUploadUrl(id: string, url: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE chunks SET upload_url = ?, updated_at = ? WHERE id = ?')
      .run(url, now, id);
  }

  setTranscriptId(id: string, transcriptId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE chunks SET transcript_id = ?, status = 'polling', updated_at = ? WHERE id = ?`,
      )
      .run(transcriptId, now, id);
  }

  resetToPending(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE chunks SET status = 'pending', retry_count = 0, last_error = NULL,
         upload_url = NULL, transcript_id = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
  }
}

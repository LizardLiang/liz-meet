// electron/db/segment-repository.ts
// Typed operations for segments + FTS5 search.

import type Database from 'better-sqlite3';
import type { Segment, SearchResult } from '../../src/types/liz-transcribe.js';
import { mapSegment } from './mappers.js';

export interface CreateSegmentInput {
  sessionId: string;
  chunkId: string | null;
  stream: 'mic' | 'system';
  speakerLabel: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence?: number | null;
  isFailedPlaceholder?: boolean;
}

export interface SearchOptions {
  limit?: number;
}

export class SegmentRepository {
  constructor(private db: Database.Database) {}

  /** Bulk insert segments in a single transaction */
  bulkInsert(segments: CreateSegmentInput[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO segments
       (session_id, chunk_id, stream, speaker_label, start_seconds, end_seconds,
        text, confidence, is_failed_placeholder)
       VALUES (@sessionId, @chunkId, @stream, @speakerLabel, @startSeconds, @endSeconds,
        @text, @confidence, @isFailedPlaceholder)`,
    );
    const insertMany = this.db.transaction((rows: CreateSegmentInput[]) => {
      for (const row of rows) {
        stmt.run({
          sessionId: row.sessionId,
          chunkId: row.chunkId ?? null,
          stream: row.stream,
          speakerLabel: row.speakerLabel,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds,
          text: row.text,
          confidence: row.confidence ?? null,
          isFailedPlaceholder: row.isFailedPlaceholder ? 1 : 0,
        });
      }
    });
    insertMany(segments);
  }

  findBySessionId(sessionId: string): Segment[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM segments WHERE session_id = ? ORDER BY start_seconds',
      )
      .all(sessionId);
    return rows.map(r => mapSegment(r as Parameters<typeof mapSegment>[0]));
  }

  deleteByChunkId(chunkId: string): void {
    this.db.prepare('DELETE FROM segments WHERE chunk_id = ?').run(chunkId);
  }

  deleteBySessionId(sessionId: string): void {
    this.db.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId);
  }

  /**
   * Sanitize a FTS5 query string to prevent injection and event-loop blocking.
   * - Enforces max 200-char length.
   * - Escapes FTS5 special characters by wrapping the entire input in double-quotes,
   *   which forces FTS5 to treat it as a literal phrase search. Internal double-quotes
   *   are escaped per the FTS5 spec (doubled: "" → literal ").
   */
  private sanitizeFts5Query(raw: string): string {
    if (raw.length > 200) raw = raw.slice(0, 200);
    // Wrap in double-quotes for a phrase search; escape any embedded quotes.
    const escaped = raw.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  /**
   * FTS5 full-text search.
   * Uses STX (U+0002) and ETX (U+0003) as highlight markers — NOT HTML.
   * The renderer splits on those control characters and renders <mark> JSX.
   * Query is sanitized before passing to FTS5 MATCH (H-01).
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 50;
    query = this.sanitizeFts5Query(query);
    // snippet(segments_fts, 0, STX, ETX, '...', 32) extracts ±2 word context
    const STX = '';
    const ETX = '';
    const rows = this.db
      .prepare(
        `SELECT
           s.session_id,
           s.id AS segment_id,
           s.start_seconds,
           s.speaker_label,
           snippet(segments_fts, 0, ?, ?, '...', 32) AS snippet
         FROM segments_fts
         JOIN segments s ON s.id = segments_fts.rowid
         WHERE segments_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(STX, ETX, query, limit);

    return rows.map(r => {
      const row = r as {
        session_id: string;
        segment_id: number;
        start_seconds: number;
        speaker_label: string;
        snippet: string;
      };
      return {
        sessionId: row.session_id,
        segmentId: row.segment_id,
        startSeconds: row.start_seconds,
        speakerLabel: row.speaker_label,
        snippet: row.snippet,
      };
    });
  }
}

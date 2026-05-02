// electron/db/session-repository.ts
// Typed CRUD for the sessions table.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Session, SessionStatus, AudioSource } from '../../src/types/liz-transcribe.js';
import { mapSession } from './mappers.js';

export interface CreateSessionInput {
  title: string;
  source: AudioSource;
  provider?: 'assemblyai' | 'deepgram';
  noticeHashAtCreation?: string;
}

export interface ListSessionsArgs {
  offset?: number;
  limit?: number;
  status?: SessionStatus[];
  dateFrom?: string;
  dateTo?: string;
}

export class SessionRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, source, provider, status, created_at, started_at, notice_hash_at_creation)
         VALUES (@id, @title, @source, @provider, 'recording', @createdAt, @startedAt, @noticeHash)`,
      )
      .run({
        id,
        title: input.title,
        source: input.source,
        provider: input.provider ?? 'assemblyai',
        createdAt: now,
        startedAt: now,
        noticeHash: input.noticeHashAtCreation ?? null,
      });
    return this.findById(id)!;
  }

  findById(id: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id);
    return row ? mapSession(row as Parameters<typeof mapSession>[0]) : null;
  }

  findAll(args: ListSessionsArgs = {}): Session[] {
    const { offset = 0, limit = 100, status, dateFrom, dateTo } = args;
    const conditions: string[] = [];
    const params: Record<string, unknown> = { offset, limit };

    if (status && status.length > 0) {
      const placeholders = status.map((_, i) => `@s${i}`).join(',');
      conditions.push(`status IN (${placeholders})`);
      status.forEach((s, i) => { params[`s${i}`] = s; });
    }
    if (dateFrom) {
      conditions.push('created_at >= @dateFrom');
      params['dateFrom'] = dateFrom;
    }
    if (dateTo) {
      conditions.push('created_at <= @dateTo');
      params['dateTo'] = dateTo;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all(params);
    return rows.map(r => mapSession(r as Parameters<typeof mapSession>[0]));
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run(status, id);
  }

  updateMeta(id: string, meta: { title?: string; notes?: string }): Session {
    if (meta.title !== undefined) {
      this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(meta.title, id);
    }
    if (meta.notes !== undefined) {
      this.db.prepare('UPDATE sessions SET notes = ? WHERE id = ?').run(meta.notes, id);
    }
    return this.findById(id)!;
  }

  updateEndTime(id: string, endedAt: string, durationSeconds: number): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?')
      .run(endedAt, durationSeconds, id);
  }

  updateSpeakerCount(id: string, speakerCount: number): void {
    this.db
      .prepare('UPDATE sessions SET speaker_count = ? WHERE id = ?')
      .run(speakerCount, id);
  }

  updateRawAudioPath(id: string, rawAudioPath: string | null): void {
    this.db
      .prepare('UPDATE sessions SET raw_audio_path = ? WHERE id = ?')
      .run(rawAudioPath, id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }
}

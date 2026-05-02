// electron/db/speaker-label-repository.ts
// Typed operations for speaker_label_overrides table.

import type Database from 'better-sqlite3';
import type { SpeakerLabelOverride } from '../../src/types/liz-transcribe.js';
import { mapSpeakerOverride } from './mappers.js';

export class SpeakerLabelRepository {
  constructor(private db: Database.Database) {}

  upsert(sessionId: string, originalLabel: string, customLabel: string): void {
    this.db
      .prepare(
        `INSERT INTO speaker_label_overrides (session_id, original_label, custom_label)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id, original_label)
         DO UPDATE SET custom_label = excluded.custom_label`,
      )
      .run(sessionId, originalLabel, customLabel);
  }

  findBySession(sessionId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        'SELECT * FROM speaker_label_overrides WHERE session_id = ?',
      )
      .all(sessionId) as Array<{ session_id: string; original_label: string; custom_label: string }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.original_label, row.custom_label);
    }
    return map;
  }

  findAllBySession(sessionId: string): SpeakerLabelOverride[] {
    const rows = this.db
      .prepare('SELECT * FROM speaker_label_overrides WHERE session_id = ?')
      .all(sessionId);
    return rows.map(r => mapSpeakerOverride(r as Parameters<typeof mapSpeakerOverride>[0]));
  }

  deleteBySession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM speaker_label_overrides WHERE session_id = ?')
      .run(sessionId);
  }
}

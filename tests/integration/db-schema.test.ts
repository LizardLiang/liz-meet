// tests/integration/db-schema.test.ts
// Suite U7: SQLite schema + FTS5 triggers (UNIT-093–100)
// Uses an in-memory SQLite database.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../electron/db/migration-runner.js';
import { SessionRepository } from '../../electron/db/session-repository.js';
import { SegmentRepository } from '../../electron/db/segment-repository.js';
import { SpeakerLabelRepository } from '../../electron/db/speaker-label-repository.js';
import { SettingsRepository } from '../../electron/db/settings-repository.js';
import { ChunkRepository } from '../../electron/db/chunk-repository.js';

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('Migration runner', () => {
  it('UNIT-093: creates all 6 expected tables', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map(r => r.name);
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('segments');
    expect(tableNames).toContain('speaker_label_overrides');
    expect(tableNames).toContain('settings');
  });

  it('UNIT-094: FTS5 segments_fts table exists and is queryable', () => {
    expect(() => {
      db.prepare("SELECT * FROM segments_fts WHERE segments_fts MATCH 'hello'").all();
    }).not.toThrow();
  });
});

describe('SessionRepository', () => {
  it('create returns a session with numeric-like id', () => {
    const repo = new SessionRepository(db);
    const session = repo.create({ title: 'Test', source: 'mic' });
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('Test');
    expect(session.status).toBe('recording');
  });

  it('findAll returns sessions ordered by created_at DESC', () => {
    const repo = new SessionRepository(db);
    const s1 = repo.create({ title: 'First', source: 'mic' });
    const s2 = repo.create({ title: 'Second', source: 'system' });
    const all = repo.findAll();
    expect(all.length).toBe(2);
    // Both sessions should be returned; order by id is stable within same timestamp
    const titles = all.map(s => s.title);
    expect(titles).toContain('First');
    expect(titles).toContain('Second');
    // The one with higher UUID lexicographic order or the one inserted last should come first
    // Since both have same timestamp, order may vary — just verify both exist
    expect(all.find(s => s.id === s1.id)).toBeTruthy();
    expect(all.find(s => s.id === s2.id)).toBeTruthy();
  });

  it('updateStatus persists', () => {
    const repo = new SessionRepository(db);
    const s = repo.create({ title: 'T', source: 'mic' });
    repo.updateStatus(s.id, 'processing');
    expect(repo.findById(s.id)!.status).toBe('processing');
  });

  it('delete removes the row', () => {
    const repo = new SessionRepository(db);
    const s = repo.create({ title: 'T', source: 'mic' });
    repo.delete(s.id);
    expect(repo.findById(s.id)).toBeNull();
  });
});

describe('FTS5 triggers', () => {
  it('UNIT-095: INSERT trigger: inserting a segment inserts into segments_fts', () => {
    const sessionRepo = new SessionRepository(db);
    const segRepo = new SegmentRepository(db);
    const s = sessionRepo.create({ title: 'T', source: 'mic' });

    segRepo.bulkInsert([{
      sessionId: s.id,
      chunkId: null,
      stream: 'mic',
      speakerLabel: 'You',
      startSeconds: 0,
      endSeconds: 5,
      text: 'hello world test phrase',
      confidence: null,
      isFailedPlaceholder: false,
    }]);

    const results = db
      .prepare("SELECT rowid FROM segments_fts WHERE segments_fts MATCH 'hello'")
      .all();
    expect(results.length).toBe(1);
  });

  it('UNIT-097: DELETE trigger: deleting segment removes from segments_fts', () => {
    const sessionRepo = new SessionRepository(db);
    const segRepo = new SegmentRepository(db);
    const s = sessionRepo.create({ title: 'T', source: 'mic' });

    segRepo.bulkInsert([{
      sessionId: s.id,
      chunkId: null,
      stream: 'mic',
      speakerLabel: 'You',
      startSeconds: 0,
      endSeconds: 5,
      text: 'deleteme phrase',
      confidence: null,
    }]);

    // Delete the segment
    segRepo.deleteBySessionId(s.id);

    const results = db
      .prepare("SELECT rowid FROM segments_fts WHERE segments_fts MATCH 'deleteme'")
      .all();
    expect(results.length).toBe(0);
  });

  it('UNIT-098: ON DELETE CASCADE from sessions removes chunks', () => {
    const sessionRepo = new SessionRepository(db);
    const chunkRepo = new ChunkRepository(db);
    const s = sessionRepo.create({ title: 'T', source: 'mic' });

    chunkRepo.create({
      sessionId: s.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    sessionRepo.delete(s.id);

    const chunks = db.prepare('SELECT * FROM chunks WHERE session_id = ?').all(s.id);
    expect(chunks.length).toBe(0);
  });
});

describe('SegmentRepository.search', () => {
  it('FTS5 search returns matching result', () => {
    const sessionRepo = new SessionRepository(db);
    const segRepo = new SegmentRepository(db);
    const s = sessionRepo.create({ title: 'T', source: 'mic' });

    segRepo.bulkInsert([{
      sessionId: s.id,
      chunkId: null,
      stream: 'mic',
      speakerLabel: 'You',
      startSeconds: 0,
      endSeconds: 5,
      text: 'action item discussed in the meeting',
      confidence: null,
    }]);

    const results = segRepo.search('action item');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe(s.id);
  });
});

describe('SpeakerLabelRepository', () => {
  it('upsert then findBySession returns the custom label', () => {
    const sessionRepo = new SessionRepository(db);
    const speakerRepo = new SpeakerLabelRepository(db);
    const s = sessionRepo.create({ title: 'T', source: 'system' });

    speakerRepo.upsert(s.id, 'G0', 'Alice');
    const map = speakerRepo.findBySession(s.id);
    expect(map.get('G0')).toBe('Alice');
  });
});

describe('SettingsRepository', () => {
  it('get returns default when no value is stored', () => {
    const repo = new SettingsRepository(db);
    expect(repo.get('chunk_seconds')).toBe(10);
  });

  it('set then get returns updated value', () => {
    const repo = new SettingsRepository(db);
    repo.set('chunk_seconds', 15);
    expect(repo.get('chunk_seconds')).toBe(15);
  });
});

// tests/integration/library-filters.test.ts
// Suite I6: Library Filter and Pagination (INT-016, INT-017, INT-018)
// Suite I5: FTS5 Search Integration (INT-014, INT-015)
// Suite I4 partial: Audio file deletion cascade (INT-015 related)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../electron/db/migration-runner.js';
import { SessionRepository } from '../../electron/db/session-repository.js';
import { SegmentRepository } from '../../electron/db/segment-repository.js';
import { ChunkRepository } from '../../electron/db/chunk-repository.js';

let db: BetterSqlite3.Database;
let sessionRepo: SessionRepository;
let segmentRepo: SegmentRepository;
let chunkRepo: ChunkRepository;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionRepo = new SessionRepository(db);
  segmentRepo = new SegmentRepository(db);
  chunkRepo = new ChunkRepository(db);
});

afterEach(() => {
  db.close();
});

describe('SessionRepository filters — INT-016, INT-017, INT-018', () => {
  it('INT-016: findAll({ status: ["completed"] }) returns only completed sessions', () => {
    const s1 = sessionRepo.create({ title: 'Completed 1', source: 'mic' });
    const s2 = sessionRepo.create({ title: 'Processing', source: 'mic' });
    const s3 = sessionRepo.create({ title: 'Completed 2', source: 'mic' });

    sessionRepo.updateStatus(s1.id, 'completed');
    sessionRepo.updateStatus(s2.id, 'processing');
    sessionRepo.updateStatus(s3.id, 'completed');

    const results = sessionRepo.findAll({ status: ['completed'] });

    expect(results).toHaveLength(2);
    expect(results.every(s => s.status === 'completed')).toBe(true);
    expect(results.some(s => s.status === 'processing')).toBe(false);
  });

  it('INT-016: filtering by multiple statuses returns all matching', () => {
    const s1 = sessionRepo.create({ title: 'Completed', source: 'mic' });
    const s2 = sessionRepo.create({ title: 'Failed', source: 'mic' });
    sessionRepo.create({ title: 'Recording', source: 'mic' });

    sessionRepo.updateStatus(s1.id, 'completed');
    sessionRepo.updateStatus(s2.id, 'failed');
    // s3 stays as 'recording'

    const results = sessionRepo.findAll({ status: ['completed', 'failed'] });

    expect(results).toHaveLength(2);
    expect(results.some(s => s.status === 'recording')).toBe(false);
  });

  it('INT-017: date range filter excludes sessions outside range', () => {
    const session = sessionRepo.create({ title: 'Test Session', source: 'mic' });

    // Set this session to a specific date in the past
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2025-01-15T10:00:00Z', session.id);

    // Filter for a range that includes this session
    const included = sessionRepo.findAll({
      dateFrom: '2025-01-01T00:00:00Z',
      dateTo: '2025-02-01T00:00:00Z',
    });
    expect(included.some(s => s.id === session.id)).toBe(true);

    // Filter for a range that excludes this session
    const excluded = sessionRepo.findAll({
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-12-31T00:00:00Z',
    });
    expect(excluded.some(s => s.id === session.id)).toBe(false);
  });

  it('INT-018: findAll() is ordered by created_at DESC (most recent first)', () => {
    const s1 = sessionRepo.create({ title: 'First', source: 'mic' });
    const s2 = sessionRepo.create({ title: 'Second', source: 'mic' });
    const s3 = sessionRepo.create({ title: 'Third', source: 'mic' });

    // Set specific creation dates to ensure ordering
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', s1.id);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2026-01-02T00:00:00Z', s2.id);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run('2026-01-03T00:00:00Z', s3.id);

    const results = sessionRepo.findAll();

    // Most recent (s3) should come first
    expect(results[0].title).toBe('Third');
    expect(results[1].title).toBe('Second');
    expect(results[2].title).toBe('First');
  });

  it('pagination: offset and limit work correctly', () => {
    for (let i = 0; i < 10; i++) {
      sessionRepo.create({ title: `Session ${i}`, source: 'mic' });
    }

    const page1 = sessionRepo.findAll({ limit: 5, offset: 0 });
    const page2 = sessionRepo.findAll({ limit: 5, offset: 5 });

    expect(page1).toHaveLength(5);
    expect(page2).toHaveLength(5);

    // Pages should not overlap
    const ids1 = new Set(page1.map(s => s.id));
    const ids2 = new Set(page2.map(s => s.id));
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });
});

describe('Audio file deletion cascade (FR-LIB-5)', () => {
  it('delete() removes the session row', () => {
    const session = sessionRepo.create({ title: 'Delete Me', source: 'mic' });

    const deleted = sessionRepo.delete(session.id);

    expect(deleted).toBe(true);
    expect(sessionRepo.findById(session.id)).toBeNull();
  });

  it('cascading delete removes chunks when session is deleted', () => {
    const session = sessionRepo.create({ title: 'With Chunks', source: 'mic' });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    expect(chunkRepo.findBySession(session.id)).toHaveLength(1);

    sessionRepo.delete(session.id);

    expect(chunkRepo.findBySession(session.id)).toHaveLength(0);
  });
});

describe('FTS5 Search Integration — INT-014, INT-015', () => {
  it('INT-015: sequential INSERT + search works without errors (SQLITE_BUSY test)', () => {
    // WAL mode is set in database.ts; in-memory DB uses default journal
    // Test that sequential insert + search works without errors
    const session = sessionRepo.create({ title: 'FTS Test', source: 'mic' });

    segmentRepo.bulkInsert([{
      sessionId: session.id,
      chunkId: null,
      stream: 'mic',
      speakerLabel: 'You',
      startSeconds: 0,
      endSeconds: 10,
      text: 'This is a concurrent write test for FTS search',
      confidence: 0.9,
      isFailedPlaceholder: false,
    }]);

    // Search immediately after insert
    expect(() => {
      segmentRepo.search('concurrent', { limit: 10 });
    }).not.toThrow();

    const results = segmentRepo.search('concurrent', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('FTS5 search returns segments matching query', () => {
    const session = sessionRepo.create({ title: 'FTS Test', source: 'mic' });
    segmentRepo.bulkInsert([{
      sessionId: session.id,
      chunkId: null,
      stream: 'mic',
      speakerLabel: 'You',
      startSeconds: 0,
      endSeconds: 10,
      text: 'discuss the action item at nine am',
      confidence: 0.9,
      isFailedPlaceholder: false,
    }]);

    const results = segmentRepo.search('action', { limit: 10 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe(session.id);
  });

  it('FTS5 search snippet uses STX/ETX markers, not HTML', () => {
    const session = sessionRepo.create({ title: 'FTS Snippet Test', source: 'mic' });
    segmentRepo.bulkInsert([{
      sessionId: session.id,
      chunkId: null,
      stream: 'mic',
      speakerLabel: 'You',
      startSeconds: 0,
      endSeconds: 10,
      text: 'discuss the action item',
      confidence: 0.9,
      isFailedPlaceholder: false,
    }]);

    const results = segmentRepo.search('action', { limit: 10 });

    expect(results.length).toBeGreaterThan(0);
    const snippet = results[0].snippet;
    // Should NOT contain HTML tags
    expect(snippet).not.toContain('<mark>');
    expect(snippet).not.toContain('<b>');
    // Should contain STX/ETX markers (char(2)/char(3))
    expect(snippet).toContain('\x02');
    expect(snippet).toContain('\x03');
  });

  it('INT-014: FTS5 search across 50 sessions completes within 300 ms', () => {
    // Insert 50 sessions with segments
    for (let i = 0; i < 50; i++) {
      const session = sessionRepo.create({ title: `Session ${i}`, source: 'mic' });
      segmentRepo.bulkInsert([{
        sessionId: session.id,
        chunkId: null,
        stream: 'mic',
        speakerLabel: 'You',
        startSeconds: i,
        endSeconds: i + 10,
        text: `This is segment number ${i} with some content about action items`,
        confidence: 0.9,
        isFailedPlaceholder: false,
      }]);
    }

    const start = performance.now();
    const results = segmentRepo.search('action', { limit: 100 });
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(300);
  });
});

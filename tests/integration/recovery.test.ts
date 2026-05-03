// tests/integration/recovery.test.ts
// Suite I8: Crash Recovery (INT-021, INT-022)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('electron', () => ({
  app: {
    // getPath is called in recovery.ts to find userData/recordings
    getPath: vi.fn(() => testUserDataDir),
  },
}));

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMigrations } from '../../electron/db/migration-runner.js';
import { SessionRepository } from '../../electron/db/session-repository.js';
import { ChunkRepository } from '../../electron/db/chunk-repository.js';
import { detectOrphanedSessions } from '../../electron/capture/recovery.js';
import { app } from 'electron';

let testUserDataDir: string;
let db: BetterSqlite3.Database;
let sessionRepo: SessionRepository;
let chunkRepo: ChunkRepository;

beforeEach(() => {
  testUserDataDir = path.join(os.tmpdir(), `liz-recovery-test-${randomUUID()}`);
  mkdirSync(testUserDataDir, { recursive: true });
  vi.mocked(app.getPath).mockReturnValue(testUserDataDir);

  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  sessionRepo = new SessionRepository(db);
  chunkRepo = new ChunkRepository(db);
});

afterEach(() => {
  db.close();
  if (existsSync(testUserDataDir)) {
    rmSync(testUserDataDir, { recursive: true, force: true });
  }
});

function createOrphanedWavFile(sessionId: string, stream: 'mic' | 'system', seq: number): string {
  const dir = path.join(testUserDataDir, 'recordings', sessionId, stream);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${String(seq).padStart(6, '0')}.wav`);
  // Write a minimal WAV header
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  writeFileSync(filePath, header);
  return filePath;
}

describe('detectOrphanedSessions — INT-021', () => {
  it('INT-021: recording session with orphan WAV files → chunks re-inserted as pending', () => {
    // Create a session stuck in recording state (simulating a crash)
    const session = sessionRepo.create({ title: 'Crashed Session', source: 'mic' });
    // Session is in 'recording' status (default from create)

    // Create orphaned WAV files (no corresponding chunk rows)
    createOrphanedWavFile(session.id, 'mic', 0);
    createOrphanedWavFile(session.id, 'mic', 1);

    // Initially no chunk rows
    expect(chunkRepo.findBySession(session.id)).toHaveLength(0);

    // Run recovery
    const candidates = detectOrphanedSessions(sessionRepo, chunkRepo);

    // Session should be returned as recoverable
    expect(candidates.some(c => c.sessionId === session.id)).toBe(true);

    // Orphaned files should now have corresponding chunk rows (pending)
    const chunks = chunkRepo.findBySession(session.id);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every(c => c.status === 'pending')).toBe(true);
  });

  it('paused session with orphan files is also recovered', () => {
    const session = sessionRepo.create({ title: 'Paused Session', source: 'mic' });
    sessionRepo.updateStatus(session.id, 'paused');

    createOrphanedWavFile(session.id, 'mic', 0);

    const candidates = detectOrphanedSessions(sessionRepo, chunkRepo);

    expect(candidates.some(c => c.sessionId === session.id)).toBe(true);
  });

  it('chunk rows with missing files → marked permanently_failed', () => {
    const session = sessionRepo.create({ title: 'Missing File Session', source: 'mic' });

    // Create the recordings directory so reconcileOrphanedFiles runs (it checks existsSync(recordingsDir))
    const recordingsDir = path.join(testUserDataDir, 'recordings', session.id);
    mkdirSync(recordingsDir, { recursive: true });

    // Create a chunk row pointing to a file that doesn't exist
    const missingFilePath = path.join(testUserDataDir, 'recordings', session.id, 'mic', '000000.wav');
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: missingFilePath,
      startSeconds: 0,
      endSeconds: 10,
    });

    detectOrphanedSessions(sessionRepo, chunkRepo);

    const chunks = chunkRepo.findBySession(session.id);
    expect(chunks.some(c => c.status === 'permanently_failed')).toBe(true);
  });
});

describe('detectOrphanedSessions — INT-022 (stale sessions)', () => {
  it('INT-022: stale session > 24h with no transcribed chunks → auto-finalized to failed', () => {
    const session = sessionRepo.create({ title: 'Stale Session', source: 'mic' });

    // Manually set started_at to 25 hours ago
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(twentyFiveHoursAgo, session.id);

    // No transcribed chunks
    detectOrphanedSessions(sessionRepo, chunkRepo);

    const updated = sessionRepo.findById(session.id);
    expect(updated?.status).toBe('failed');
  });

  it('INT-022: stale session is NOT returned in recoverable candidates', () => {
    const session = sessionRepo.create({ title: 'Stale Session', source: 'mic' });

    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(twentyFiveHoursAgo, session.id);

    const candidates = detectOrphanedSessions(sessionRepo, chunkRepo);

    expect(candidates.some(c => c.sessionId === session.id)).toBe(false);
  });

  it('recent session (< 24h) is not auto-failed', () => {
    const session = sessionRepo.create({ title: 'Recent Session', source: 'mic' });
    // No WAV files, no chunks → still recent, not stale

    const candidates = detectOrphanedSessions(sessionRepo, chunkRepo);

    const updated = sessionRepo.findById(session.id);
    // Recent session should remain in recording state, not auto-failed
    expect(updated?.status).toBe('recording');
    expect(candidates.some(c => c.sessionId === session.id)).toBe(true);
  });

  it('no recording/paused sessions → empty candidate list', () => {
    const session = sessionRepo.create({ title: 'Completed Session', source: 'mic' });
    sessionRepo.updateStatus(session.id, 'completed');

    const candidates = detectOrphanedSessions(sessionRepo, chunkRepo);

    expect(candidates).toHaveLength(0);
  });

  it('session with transcribed chunks is not auto-failed even if stale', () => {
    const session = sessionRepo.create({ title: 'Stale But Transcribed', source: 'mic' });

    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(twentyFiveHoursAgo, session.id);

    // Add a transcribed chunk
    const chunk = chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });
    chunkRepo.updateStatus(chunk.id, 'transcribed');

    detectOrphanedSessions(sessionRepo, chunkRepo);

    // Should NOT be auto-failed since it has transcribed chunks
    const updated = sessionRepo.findById(session.id);
    expect(updated?.status).not.toBe('failed');
  });
});

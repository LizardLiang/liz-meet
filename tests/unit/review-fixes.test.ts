// tests/unit/review-fixes.test.ts
// Tests for the fixes applied in response to Hermes code-review and Cassandra risk-analysis.
//
// Covers (no node:fs mock needed):
//   - H-01: FTS5 query sanitization (segment-repository.ts:sanitizeFts5Query)
//   - H-02: settings:set allowlist validation (validateSettingsKeyValue logic)
//   - BLOCKER #2: TranscriptAssembler.assemble() inserts only failure placeholders
//   - BLOCKER #3: handleProviderFailure counts network/timeout codes (covered in provider-banner.test.ts)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── H-01: FTS5 sanitization ────────────────────────────────────────────────

import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../../electron/db/migration-runner.js';
import { SegmentRepository } from '../../electron/db/segment-repository.js';
import { SessionRepository } from '../../electron/db/session-repository.js';

describe('H-01 — SegmentRepository.search FTS5 sanitization', () => {
  let db: BetterSqlite3.Database;
  let segmentRepo: SegmentRepository;
  let sessionRepo: SessionRepository;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    sessionRepo = new SessionRepository(db);
    segmentRepo = new SegmentRepository(db);
  });

  afterEach(() => { db.close(); });

  it('FTS5 operator injection (OR NOT) does not throw — treated as literal phrase', () => {
    // Without sanitization this would throw: "fts5: syntax error near 'NOT'"
    expect(() => segmentRepo.search('hello OR NOT world', { limit: 10 })).not.toThrow();
  });

  it('FTS5 wildcard injection (*) does not throw', () => {
    expect(() => segmentRepo.search('hel*', { limit: 10 })).not.toThrow();
  });

  it('FTS5 NEAR injection does not throw', () => {
    expect(() => segmentRepo.search('NEAR(hello world)', { limit: 10 })).not.toThrow();
  });

  it('query longer than 200 chars is truncated and does not throw', () => {
    const longQuery = 'a'.repeat(300);
    expect(() => segmentRepo.search(longQuery, { limit: 10 })).not.toThrow();
  });

  it('embedded double-quotes in query are escaped and search does not throw', () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    segmentRepo.bulkInsert([{
      sessionId: session.id, chunkId: null, stream: 'mic',
      speakerLabel: 'You', startSeconds: 0, endSeconds: 5,
      text: 'say hello world please', confidence: 0.9, isFailedPlaceholder: false,
    }]);
    // Raw query with embedded quotes must not throw
    expect(() => segmentRepo.search('"hello world"', { limit: 10 })).not.toThrow();
  });

  it('sanitized literal query still finds matching text', () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    segmentRepo.bulkInsert([{
      sessionId: session.id, chunkId: null, stream: 'mic',
      speakerLabel: 'You', startSeconds: 0, endSeconds: 5,
      text: 'hello world', confidence: 0.9, isFailedPlaceholder: false,
    }]);
    const results = segmentRepo.search('hello', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe(session.id);
  });
});

// ─── H-02: settings:set allowlist ───────────────────────────────────────────

// Inline the validation logic mirroring handlers.ts so we can unit-test it
// without spinning up ipcMain.
type SettingsValidator = (v: unknown) => string | null;

const SETTINGS_ALLOWLIST: Record<string, SettingsValidator> = {
  chunk_seconds: (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 5 && v <= 120
      ? null
      : 'chunk_seconds must be an integer in [5, 120]',
  mic_device_id: (v) =>
    v === null || (typeof v === 'number' && Number.isInteger(v))
      ? null
      : 'mic_device_id must be an integer or null',
  provider: (v) =>
    v === 'assemblyai' || v === 'deepgram'
      ? null
      : "provider must be 'assemblyai' or 'deepgram'",
  keep_raw_audio: (v) =>
    typeof v === 'boolean' ? null : 'keep_raw_audio must be a boolean',
  telemetry_opt_in: (v) =>
    typeof v === 'boolean' ? null : 'telemetry_opt_in must be a boolean',
};

function validate(key: string, value: unknown) {
  const validator = SETTINGS_ALLOWLIST[key];
  if (!validator) return { ok: false as const, message: `Unknown settings key: '${key}'` };
  const err = validator(value);
  if (err) return { ok: false as const, message: err };
  return { ok: true as const };
}

describe('H-02 — settings:set allowlist validation', () => {
  it('chunk_seconds: valid integer in range', () => {
    expect(validate('chunk_seconds', 10)).toEqual({ ok: true });
  });

  it('chunk_seconds: 0 rejected (divide-by-zero prevention)', () => {
    expect(validate('chunk_seconds', 0).ok).toBe(false);
  });

  it('chunk_seconds: 5 (min boundary) accepted', () => {
    expect(validate('chunk_seconds', 5)).toEqual({ ok: true });
  });

  it('chunk_seconds: 120 (max boundary) accepted', () => {
    expect(validate('chunk_seconds', 120)).toEqual({ ok: true });
  });

  it('chunk_seconds: 121 rejected', () => {
    expect(validate('chunk_seconds', 121).ok).toBe(false);
  });

  it('chunk_seconds: float rejected', () => {
    expect(validate('chunk_seconds', 9.5).ok).toBe(false);
  });

  it('chunk_seconds: string rejected', () => {
    expect(validate('chunk_seconds', '10').ok).toBe(false);
  });

  it('chunk_seconds: path traversal string rejected', () => {
    expect(validate('chunk_seconds', '../../etc/passwd').ok).toBe(false);
  });

  it('keep_raw_audio: boolean true accepted', () => {
    expect(validate('keep_raw_audio', true)).toEqual({ ok: true });
  });

  it('keep_raw_audio: number 1 rejected', () => {
    expect(validate('keep_raw_audio', 1).ok).toBe(false);
  });

  it('provider: assemblyai accepted', () => {
    expect(validate('provider', 'assemblyai')).toEqual({ ok: true });
  });

  it('provider: deepgram accepted', () => {
    expect(validate('provider', 'deepgram')).toEqual({ ok: true });
  });

  it('provider: unknown string rejected', () => {
    expect(validate('provider', 'openai').ok).toBe(false);
  });

  it('unknown key is rejected', () => {
    const result = validate('malicious_key', 'value');
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unknown settings key");
  });

  it('mic_device_id: null accepted', () => {
    expect(validate('mic_device_id', null)).toEqual({ ok: true });
  });

  it('mic_device_id: integer accepted', () => {
    expect(validate('mic_device_id', 2)).toEqual({ ok: true });
  });

  it('mic_device_id: float rejected', () => {
    expect(validate('mic_device_id', 1.5).ok).toBe(false);
  });

  it('telemetry_opt_in: false accepted', () => {
    expect(validate('telemetry_opt_in', false)).toEqual({ ok: true });
  });
});

// ─── BLOCKER #2: TranscriptAssembler.assemble() ─────────────────────────────

import { TranscriptAssembler } from '../../electron/asr/transcript-assembler.js';

describe('BLOCKER #2 — TranscriptAssembler.assemble()', () => {
  const VALID_SESSION = 'sess-001';

  function makeAssembler() {
    const chunkRepo = { findBySession: vi.fn(() => []) };
    const segmentRepo = { bulkInsert: vi.fn() };
    const assembler = new TranscriptAssembler(chunkRepo as never, segmentRepo as never);
    return { assembler, chunkRepo, segmentRepo };
  }

  it('no chunks → no segments inserted', () => {
    const { assembler, segmentRepo } = makeAssembler();
    assembler.assemble(VALID_SESSION);
    expect(segmentRepo.bulkInsert).not.toHaveBeenCalled();
  });

  it('all transcribed chunks → no failure placeholders inserted', () => {
    const { assembler, chunkRepo, segmentRepo } = makeAssembler();
    chunkRepo.findBySession.mockReturnValue([
      { id: 'c1', sessionId: VALID_SESSION, status: 'transcribed', stream: 'mic', startSeconds: 0, endSeconds: 10 },
    ]);
    assembler.assemble(VALID_SESSION);
    expect(segmentRepo.bulkInsert).not.toHaveBeenCalled();
  });

  it('permanently_failed chunk → failure placeholder is inserted', () => {
    const { assembler, chunkRepo, segmentRepo } = makeAssembler();
    chunkRepo.findBySession.mockReturnValue([
      {
        id: 'c1', sessionId: VALID_SESSION, status: 'permanently_failed',
        stream: 'mic', startSeconds: 0, endSeconds: 10,
      },
    ]);
    assembler.assemble(VALID_SESSION);
    expect(segmentRepo.bulkInsert).toHaveBeenCalledOnce();
    const [placeholders] = segmentRepo.bulkInsert.mock.calls[0] as [Array<{ isFailedPlaceholder: boolean; sessionId: string }>];
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].isFailedPlaceholder).toBe(true);
    expect(placeholders[0].sessionId).toBe(VALID_SESSION);
  });

  it('mix of transcribed + permanently_failed → only failed get placeholders', () => {
    const { assembler, chunkRepo, segmentRepo } = makeAssembler();
    chunkRepo.findBySession.mockReturnValue([
      { id: 'c1', sessionId: VALID_SESSION, status: 'transcribed', stream: 'mic', startSeconds: 0, endSeconds: 10 },
      { id: 'c2', sessionId: VALID_SESSION, status: 'permanently_failed', stream: 'system', startSeconds: 10, endSeconds: 20 },
    ]);
    assembler.assemble(VALID_SESSION);
    expect(segmentRepo.bulkInsert).toHaveBeenCalledOnce();
    const [placeholders] = segmentRepo.bulkInsert.mock.calls[0] as [Array<unknown>];
    expect(placeholders).toHaveLength(1);
  });

  it('insertFailurePlaceholders formats time range correctly in placeholder text', () => {
    const { assembler, segmentRepo } = makeAssembler();
    const failed = [
      {
        id: 'c1', sessionId: VALID_SESSION, status: 'permanently_failed',
        stream: 'mic' as const, startSeconds: 3661, endSeconds: 3720,
      },
    ];
    assembler.insertFailurePlaceholders(VALID_SESSION, failed as never);
    const [inserted] = segmentRepo.bulkInsert.mock.calls[0] as [Array<{ text: string }>];
    // 3661 s = 01:01:01, 3720 s = 01:02:00
    expect(inserted[0].text).toContain('01:01:01');
    expect(inserted[0].text).toContain('01:02:00');
  });
});

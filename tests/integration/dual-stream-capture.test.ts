// tests/integration/dual-stream-capture.test.ts
// Suite I1: Dual-stream capture integration (INT-001–006)
// FR-CAP-2: Two independent WAV buffers produced simultaneously (mic + loopback)
// FR-CAP-3/4: Mic-only and system-only mode
// FR-CAP-2: Chunk boundary alignment between streams

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';

// Mock electron and native modules — must precede all imports of source files
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/dual-stream-test' },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Intercept file I/O functions used by ChunkAccumulator and LoopbackRecorder
    writeFileSync: vi.fn(),
    openSync: vi.fn(() => 3),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../electron/ipc/notifier.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../electron/ipc/channels.js', () => ({
  PUSH_CHANNELS: {
    CAPTURE_VU_UPDATE: 'capture:vu-update',
    ASR_PROVIDER_BANNER: 'asr:provider-banner',
    ASR_UPLOAD_SLOW: 'asr:upload-slow',
    SESSION_STATUS_CHANGED: 'session:status-changed',
  },
}));

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMigrations } from '../../electron/db/migration-runner.js';
import { SessionRepository } from '../../electron/db/session-repository.js';
import { ChunkRepository } from '../../electron/db/chunk-repository.js';
import { ChunkAccumulator } from '../../electron/capture/chunk-accumulator.js';
import { LoopbackRecorder } from '../../electron/capture/loopback-recorder.js';
import * as fs from 'node:fs';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2; // 16-bit

function makePcm(seconds: number): Buffer {
  const byteCount = Math.floor(seconds * SAMPLE_RATE * BYTES_PER_SAMPLE);
  // Non-zero PCM so VU meter returns meaningful values
  const buf = Buffer.alloc(byteCount);
  for (let i = 0; i < byteCount; i += 2) {
    buf.writeInt16LE(Math.floor(Math.random() * 0x7fff), i);
  }
  return buf;
}

function makeArrayBuffer(sizeBytes: number): ArrayBuffer {
  const ab = new ArrayBuffer(sizeBytes);
  const view = new Uint8Array(ab);
  for (let i = 0; i < sizeBytes; i++) view[i] = i % 256;
  return ab;
}

const stubWin = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
};

let db: BetterSqlite3.Database;
let sessionRepo: SessionRepository;
let chunkRepo: ChunkRepository;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionRepo = new SessionRepository(db);
  chunkRepo = new ChunkRepository(db);
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.openSync).mockReturnValue(3 as never);
});

afterEach(() => {
  db.close();
});

describe('Dual-stream capture — INT-001–006', () => {
  // INT-001: Two independent WAV buffers produced simultaneously (mic + loopback)
  it('INT-001: mic and loopback accumulators produce independent chunk rows in DB', () => {
    const session = sessionRepo.create({ title: 'Dual Stream Test', source: 'both' });

    // Mic: ChunkAccumulator with 10-second chunks
    const micAcc = new ChunkAccumulator(
      session.id,
      'mic',
      10,
      chunkRepo,
      stubWin as never,
    );

    // System (loopback): ChunkAccumulator with 10-second chunks
    const sysAcc = new ChunkAccumulator(
      session.id,
      'system',
      10,
      chunkRepo,
      stubWin as never,
    );

    // Feed 10 seconds of PCM to each — should trigger one chunk per stream
    micAcc.push(makePcm(10));
    sysAcc.push(makePcm(10));

    const allChunks = chunkRepo.findBySession(session.id);
    const micChunks = allChunks.filter(c => c.stream === 'mic');
    const sysChunks = allChunks.filter(c => c.stream === 'system');

    expect(micChunks).toHaveLength(1);
    expect(sysChunks).toHaveLength(1);
  });

  it('INT-001b: mic and system chunk file paths are in separate subdirectories', () => {
    const session = sessionRepo.create({ title: 'Path Test', source: 'both' });

    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);

    micAcc.push(makePcm(10));
    sysAcc.push(makePcm(10));

    const allChunks = chunkRepo.findBySession(session.id);
    const micChunk = allChunks.find(c => c.stream === 'mic');
    const sysChunk = allChunks.find(c => c.stream === 'system');

    expect(micChunk).toBeDefined();
    expect(sysChunk).toBeDefined();
    // Mic path must contain '/mic/' subdirectory
    expect(micChunk!.filePath).toMatch(/[/\\]mic[/\\]/);
    // System path must contain '/system/' subdirectory
    expect(sysChunk!.filePath).toMatch(/[/\\]system[/\\]/);
    // They must be different paths
    expect(micChunk!.filePath).not.toBe(sysChunk!.filePath);
  });

  it('INT-002: WAV files written for both streams (writeFileSync called twice for dual-stream)', () => {
    const session = sessionRepo.create({ title: 'WAV Write Test', source: 'both' });

    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);

    micAcc.push(makePcm(10));
    sysAcc.push(makePcm(10));

    // Two separate writeFileSync calls (one per stream)
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBeGreaterThanOrEqual(2);

    // Each written buffer should start with 'RIFF'
    const writtenPaths = vi.mocked(fs.writeFileSync).mock.calls.map(
      ([p]) => String(p),
    );
    const micPath = writtenPaths.find(p => p.includes('mic'));
    const sysPath = writtenPaths.find(p => p.includes('system'));
    expect(micPath).toBeDefined();
    expect(sysPath).toBeDefined();
  });

  it('INT-002b: both WAV buffers start with RIFF header (non-empty)', () => {
    const session = sessionRepo.create({ title: 'RIFF Test', source: 'both' });

    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);

    micAcc.push(makePcm(10));
    sysAcc.push(makePcm(10));

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    for (const [, buf] of writeCalls) {
      const buffer = buf as Buffer;
      expect(buffer[0]).toBe(0x52); // 'R'
      expect(buffer[1]).toBe(0x49); // 'I'
      expect(buffer[2]).toBe(0x46); // 'F'
      expect(buffer[3]).toBe(0x46); // 'F'
    }
  });

  // INT-003: Using LoopbackRecorder for system audio produces DB rows with stream='system'
  it('INT-003: LoopbackRecorder.handleChunk creates chunk with stream="system"', () => {
    const session = sessionRepo.create({ title: 'Loopback Test', source: 'both' });
    const loopback = new LoopbackRecorder(chunkRepo);
    loopback.start();

    const result = loopback.handleChunk({
      sessionId: session.id,
      seq: 0,
      mimeType: 'audio/webm',
      buffer: makeArrayBuffer(1024),
      startSeconds: 0,
      endSeconds: 10,
    });

    expect(result.ok).toBe(true);

    const chunks = chunkRepo.findBySession(session.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].stream).toBe('system');
    expect(chunks[0].seq).toBe(0);
  });

  // INT-004: Mic-only mode — no system chunks produced
  it('INT-004: mic-only mode produces no system stream chunks', () => {
    const session = sessionRepo.create({ title: 'Mic Only', source: 'mic' });

    // Only create mic accumulator, no system accumulator
    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    micAcc.push(makePcm(10));

    const allChunks = chunkRepo.findBySession(session.id);
    const sysChunks = allChunks.filter(c => c.stream === 'system');
    const micChunks = allChunks.filter(c => c.stream === 'mic');

    expect(micChunks).toHaveLength(1);
    expect(sysChunks).toHaveLength(0);
  });

  it('INT-004b: mic-only mode: LoopbackRecorder not active, handleChunk rejected', () => {
    const session = sessionRepo.create({ title: 'Mic Only Reject', source: 'mic' });
    const loopback = new LoopbackRecorder(chunkRepo);
    // NOT calling loopback.start() — simulates mic-only mode

    const result = loopback.handleChunk({
      sessionId: session.id,
      seq: 0,
      mimeType: 'audio/webm',
      buffer: makeArrayBuffer(1024),
      startSeconds: 0,
      endSeconds: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_recording');

    const chunks = chunkRepo.findBySession(session.id);
    expect(chunks).toHaveLength(0);
  });

  // INT-005: System-only mode — no mic chunks produced
  it('INT-005: system-only mode produces no mic stream chunks', () => {
    const session = sessionRepo.create({ title: 'System Only', source: 'system' });

    // Only create system accumulator, no mic accumulator
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);
    sysAcc.push(makePcm(10));

    const allChunks = chunkRepo.findBySession(session.id);
    const micChunks = allChunks.filter(c => c.stream === 'mic');
    const sysChunks = allChunks.filter(c => c.stream === 'system');

    expect(sysChunks).toHaveLength(1);
    expect(micChunks).toHaveLength(0);
  });

  // INT-006: Chunk boundary alignment between streams
  it('INT-006: chunks from both streams have non-overlapping sequential time ranges within each stream', () => {
    const session = sessionRepo.create({ title: 'Alignment Test', source: 'both' });

    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);

    // Produce 3 chunks per stream (30 seconds each)
    for (let i = 0; i < 3; i++) {
      micAcc.push(makePcm(10));
    }
    for (let i = 0; i < 3; i++) {
      sysAcc.push(makePcm(10));
    }

    const allChunks = chunkRepo.findBySession(session.id);
    const micChunks = allChunks.filter(c => c.stream === 'mic').sort((a, b) => a.seq - b.seq);
    const sysChunks = allChunks.filter(c => c.stream === 'system').sort((a, b) => a.seq - b.seq);

    expect(micChunks).toHaveLength(3);
    expect(sysChunks).toHaveLength(3);

    // Verify mic stream chunks are non-overlapping and sequential
    for (let i = 1; i < micChunks.length; i++) {
      expect(micChunks[i].startSeconds).toBeCloseTo(micChunks[i - 1].endSeconds, 0);
    }

    // Verify system stream chunks are non-overlapping and sequential
    for (let i = 1; i < sysChunks.length; i++) {
      expect(sysChunks[i].startSeconds).toBeCloseTo(sysChunks[i - 1].endSeconds, 0);
    }
  });

  it('INT-006b: sequence numbers are independent per stream (both start at 0)', () => {
    const session = sessionRepo.create({ title: 'Seq Numbers', source: 'both' });

    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);

    // 2 chunks each
    micAcc.push(makePcm(10));
    micAcc.push(makePcm(10));
    sysAcc.push(makePcm(10));
    sysAcc.push(makePcm(10));

    const allChunks = chunkRepo.findBySession(session.id);
    const micSeqs = allChunks.filter(c => c.stream === 'mic').map(c => c.seq).sort((a, b) => a - b);
    const sysSeqs = allChunks.filter(c => c.stream === 'system').map(c => c.seq).sort((a, b) => a - b);

    // Each stream has its own seq counter starting from 0
    expect(micSeqs).toEqual([0, 1]);
    expect(sysSeqs).toEqual([0, 1]);
  });

  it('INT-006c: chunk time ranges per stream span the full recording duration', () => {
    const session = sessionRepo.create({ title: 'Duration Coverage', source: 'both' });

    const micAcc = new ChunkAccumulator(session.id, 'mic', 10, chunkRepo, stubWin as never);
    const sysAcc = new ChunkAccumulator(session.id, 'system', 10, chunkRepo, stubWin as never);

    // 30 seconds per stream
    for (let i = 0; i < 3; i++) {
      micAcc.push(makePcm(10));
    }
    for (let i = 0; i < 3; i++) {
      sysAcc.push(makePcm(10));
    }

    const allChunks = chunkRepo.findBySession(session.id);
    const micChunks = allChunks.filter(c => c.stream === 'mic').sort((a, b) => a.seq - b.seq);
    const sysChunks = allChunks.filter(c => c.stream === 'system').sort((a, b) => a.seq - b.seq);

    // First chunk starts at 0
    expect(micChunks[0].startSeconds).toBeCloseTo(0, 1);
    expect(sysChunks[0].startSeconds).toBeCloseTo(0, 1);

    // Last chunk ends near 30 seconds
    expect(micChunks[micChunks.length - 1].endSeconds).toBeCloseTo(30, 0);
    expect(sysChunks[sysChunks.length - 1].endSeconds).toBeCloseTo(30, 0);
  });

  // Loopback size limit: 5 MB cap (existing behavior confirmed by integration)
  it('INT-003b: LoopbackRecorder rejects oversized chunks (> 5 MB)', () => {
    const session = sessionRepo.create({ title: 'Size Limit', source: 'both' });
    const loopback = new LoopbackRecorder(chunkRepo);
    loopback.start();

    const oversized = makeArrayBuffer(6 * 1024 * 1024); // 6 MB
    const result = loopback.handleChunk({
      sessionId: session.id,
      seq: 0,
      mimeType: 'audio/webm',
      buffer: oversized,
      startSeconds: 0,
      endSeconds: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('chunk_too_large');

    // No DB row created
    const chunks = chunkRepo.findBySession(session.id);
    expect(chunks).toHaveLength(0);
  });

  it('INT-003c: loopback chunks have correct session association', () => {
    const session1 = sessionRepo.create({ title: 'Session 1', source: 'both' });
    const session2 = sessionRepo.create({ title: 'Session 2', source: 'both' });

    const loopback = new LoopbackRecorder(chunkRepo);
    loopback.start();

    // Two chunks for session1
    loopback.handleChunk({
      sessionId: session1.id,
      seq: 0,
      mimeType: 'audio/webm',
      buffer: makeArrayBuffer(1024),
      startSeconds: 0,
      endSeconds: 10,
    });
    loopback.handleChunk({
      sessionId: session1.id,
      seq: 1,
      mimeType: 'audio/webm',
      buffer: makeArrayBuffer(1024),
      startSeconds: 10,
      endSeconds: 20,
    });

    // One chunk for session2
    loopback.handleChunk({
      sessionId: session2.id,
      seq: 0,
      mimeType: 'audio/webm',
      buffer: makeArrayBuffer(1024),
      startSeconds: 0,
      endSeconds: 10,
    });

    const s1Chunks = chunkRepo.findBySession(session1.id);
    const s2Chunks = chunkRepo.findBySession(session2.id);

    expect(s1Chunks).toHaveLength(2);
    expect(s2Chunks).toHaveLength(1);
    for (const c of s1Chunks) expect(c.sessionId).toBe(session1.id);
    for (const c of s2Chunks) expect(c.sessionId).toBe(session2.id);
  });
});

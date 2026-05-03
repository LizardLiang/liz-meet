// tests/unit/chunk-accumulator.test.ts
// Suite U1: Audio Chunking — ChunkAccumulator (UNIT-001–009)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// All vi.mock calls must use inline vi.fn() — no outer variable references (hoisting constraint)

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-userData',
  },
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 1),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

vi.mock('../../electron/ipc/notifier.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../electron/ipc/channels.js', () => ({
  PUSH_CHANNELS: {
    CAPTURE_VU_UPDATE: 'capture:vu-update',
  },
}));

import { ChunkAccumulator } from '../../electron/capture/chunk-accumulator.js';
import * as fs from 'node:fs';
import * as notifier from '../../electron/ipc/notifier.js';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2; // 16-bit

function makePcm(seconds: number): Buffer {
  const byteCount = Math.floor(seconds * SAMPLE_RATE * BYTES_PER_SAMPLE);
  return Buffer.alloc(byteCount);
}

const mockChunkCreate = vi.fn().mockReturnValue({ id: 'chunk-1' });
const stubChunkRepo = { create: mockChunkCreate };
const stubWin = { isDestroyed: () => false, webContents: { send: vi.fn() } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.openSync).mockReturnValue(1 as never);
  mockChunkCreate.mockReturnValue({ id: 'chunk-1' });
});

describe('ChunkAccumulator — UNIT-001 to UNIT-009', () => {
  it('UNIT-001: 10 s of PCM produces exactly one chunk at the 10-second boundary', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 10, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(10));
    expect(mockChunkCreate).toHaveBeenCalledTimes(1);
  });

  it('UNIT-002a: chunkDurationSeconds=5 produces 3 chunks from 15 s of audio', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 5, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(5));
    acc.push(makePcm(5));
    acc.push(makePcm(5));
    expect(mockChunkCreate).toHaveBeenCalledTimes(3);
  });

  it('UNIT-002b: chunkDurationSeconds=15 produces exactly 1 chunk from 15 s of audio', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 15, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(15));
    expect(mockChunkCreate).toHaveBeenCalledTimes(1);
  });

  it('UNIT-004: WAV file starts with RIFF magic bytes', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 10, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(10));

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenBuffer: Buffer = vi.mocked(fs.writeFileSync).mock.calls[0][1] as Buffer;

    expect(writtenBuffer[0]).toBe(0x52); // 'R'
    expect(writtenBuffer[1]).toBe(0x49); // 'I'
    expect(writtenBuffer[2]).toBe(0x46); // 'F'
    expect(writtenBuffer[3]).toBe(0x46); // 'F'
  });

  it('UNIT-005: sequence numbers are monotonically increasing (0, 1, 2)', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 5, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(5));
    acc.push(makePcm(5));
    acc.push(makePcm(5));

    expect(mockChunkCreate).toHaveBeenCalledTimes(3);
    const seqs = mockChunkCreate.mock.calls.map((call: [{ seq: number }]) => call[0].seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('UNIT-006: fsync is called before db.create (DB-First Write L3)', () => {
    const callOrder: string[] = [];
    vi.mocked(fs.fsyncSync).mockImplementation(() => { callOrder.push('fsync'); });
    mockChunkCreate.mockImplementation(() => { callOrder.push('db'); return { id: 'chunk-1' }; });

    const acc = new ChunkAccumulator('session-1', 'mic', 10, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(10));

    expect(callOrder.indexOf('fsync')).toBeLessThan(callOrder.indexOf('db'));
  });

  it('UNIT-003: partial chunk emitted on flush() with correct endSeconds', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 10, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(7));
    acc.flush();

    expect(mockChunkCreate).toHaveBeenCalledTimes(1);
    const call = mockChunkCreate.mock.calls[0][0] as { endSeconds: number };
    expect(call.endSeconds).toBeCloseTo(7, 0);
  });

  it('flush() on empty accumulator does nothing', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 10, stubChunkRepo as never, stubWin as never);
    acc.flush();
    expect(mockChunkCreate).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('VU update notify is emitted when accumulation exceeds 100 ms window', () => {
    const acc = new ChunkAccumulator('session-1', 'mic', 10, stubChunkRepo as never, stubWin as never);
    acc.push(makePcm(0.5)); // 0.5 s = 5 × 100 ms windows
    expect(notifier.notify).toHaveBeenCalled();
  });
});

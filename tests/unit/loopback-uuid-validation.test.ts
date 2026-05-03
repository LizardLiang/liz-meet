// tests/unit/loopback-uuid-validation.test.ts
// M-01 fix: LoopbackRecorder rejects non-UUID sessionId values to prevent
// path traversal attacks.

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userData' },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    openSync: vi.fn(() => 42),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LoopbackRecorder } from '../../electron/capture/loopback-recorder.js';

function makeRecorder() {
  const chunkRepo = { create: vi.fn() };
  const recorder = new LoopbackRecorder(chunkRepo as never);
  recorder.start();
  return { recorder, chunkRepo };
}

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SMALL_BUFFER = new ArrayBuffer(100);

describe('M-01 — LoopbackRecorder sessionId UUID validation', () => {
  it('valid UUID sessionId is accepted', () => {
    const { recorder } = makeRecorder();
    const result = recorder.handleChunk({
      sessionId: VALID_UUID,
      seq: 0,
      mimeType: 'audio/wav',
      buffer: SMALL_BUFFER,
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('path traversal sessionId is rejected with invalid_session_id', () => {
    const { recorder } = makeRecorder();
    const result = recorder.handleChunk({
      sessionId: '../../../etc/passwd',
      seq: 0,
      mimeType: 'audio/wav',
      buffer: SMALL_BUFFER,
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_session_id');
  });

  it('empty string sessionId is rejected', () => {
    const { recorder } = makeRecorder();
    const result = recorder.handleChunk({
      sessionId: '',
      seq: 0,
      mimeType: 'audio/wav',
      buffer: SMALL_BUFFER,
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_session_id');
  });

  it('numeric-only string sessionId is rejected', () => {
    const { recorder } = makeRecorder();
    const result = recorder.handleChunk({
      sessionId: '12345678901234567890',
      seq: 0,
      mimeType: 'audio/wav',
      buffer: SMALL_BUFFER,
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_session_id');
  });

  it('UUID with wrong segment lengths is rejected', () => {
    const { recorder } = makeRecorder();
    const result = recorder.handleChunk({
      sessionId: 'a1b2c3d4-e5f6-7890-abcd', // too short
      seq: 0,
      mimeType: 'audio/wav',
      buffer: SMALL_BUFFER,
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_session_id');
  });

  it('rejected sessionId does not create any chunk DB record', () => {
    const { recorder, chunkRepo } = makeRecorder();
    recorder.handleChunk({
      sessionId: '../exploit',
      seq: 0,
      mimeType: 'audio/wav',
      buffer: SMALL_BUFFER,
      startSeconds: 0,
      endSeconds: 1,
    });
    expect(chunkRepo.create).not.toHaveBeenCalled();
  });
});

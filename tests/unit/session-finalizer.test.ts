// tests/unit/session-finalizer.test.ts
// Suite U10: Session Finalizer (UNIT-038–041)
// Suite U12: Audio Retention (UNIT-058, UNIT-059, UNIT-059b)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userData' },
}));

vi.mock('node:fs', () => ({
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../electron/ipc/notifier.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../electron/ipc/channels.js', () => ({
  PUSH_CHANNELS: {
    SESSION_STATUS_CHANGED: 'session:status-changed',
  },
}));

import { SessionFinalizer } from '../../electron/asr/session-finalizer.js';
import * as notifier from '../../electron/ipc/notifier.js';
import * as fs from 'node:fs';
import type { Chunk, SessionStatus } from '../../src/types/liz-transcribe.js';

function makeChunk(status: string, id = 'c1'): Chunk {
  return {
    id,
    sessionId: 'sess-1',
    stream: 'mic',
    seq: 0,
    filePath: '/tmp/test.wav',
    startSeconds: 0,
    endSeconds: 10,
    status: status as Chunk['status'],
    retryCount: 0,
    lastError: null,
    uploadUrl: null,
    transcriptId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const mockChunkFindBySession = vi.fn();
const stubChunkRepo = { findBySession: mockChunkFindBySession };

const mockSessionFindById = vi.fn();
const mockSessionUpdateStatus = vi.fn();
const mockSessionUpdateRawAudioPath = vi.fn();
const stubSessionRepo = {
  findById: mockSessionFindById,
  updateStatus: mockSessionUpdateStatus,
  updateRawAudioPath: mockSessionUpdateRawAudioPath,
};

const mockSegmentRepo = {};
const mockSettingsGet = vi.fn();
const stubSettingsRepo = { get: mockSettingsGet };
const mockAssemblerAssemble = vi.fn();
const stubAssembler = { assemble: mockAssemblerAssemble };

const stubWin = { isDestroyed: () => false, webContents: { send: vi.fn() } };

function makeFinalizer() {
  return new SessionFinalizer(
    stubChunkRepo as never,
    stubSessionRepo as never,
    mockSegmentRepo as never,
    stubSettingsRepo as never,
    stubAssembler as never,
    stubWin as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettingsGet.mockReturnValue(false); // keep_raw_audio = false
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe('SessionFinalizer.finalizeIfReady', () => {
  it('UNIT-038: all chunks transcribed → session status = completed', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([
      makeChunk('transcribed', 'c1'),
      makeChunk('transcribed', 'c2'),
    ]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).toHaveBeenCalledWith('sess-1', 'completed');
  });

  it('UNIT-039: mix of transcribed + permanently_failed → completed_with_failures', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([
      makeChunk('transcribed', 'c1'),
      makeChunk('permanently_failed', 'c2'),
    ]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).toHaveBeenCalledWith('sess-1', 'completed_with_failures');
  });

  it('UNIT-040: all chunks permanently_failed → session status = failed', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([
      makeChunk('permanently_failed', 'c1'),
      makeChunk('permanently_failed', 'c2'),
    ]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).toHaveBeenCalledWith('sess-1', 'failed');
  });

  it('UNIT-041: in-flight chunks (uploading) → finalizer does not change status', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([
      makeChunk('uploading', 'c1'),
      makeChunk('transcribed', 'c2'),
    ]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).not.toHaveBeenCalled();
  });

  it('pending chunks prevent finalization', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([makeChunk('pending', 'c1')]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).not.toHaveBeenCalled();
  });

  it('polling chunks prevent finalization', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([makeChunk('polling', 'c1')]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).not.toHaveBeenCalled();
  });

  it('recording session is not finalized (capture still ongoing)', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'recording' });
    mockChunkFindBySession.mockReturnValue([makeChunk('transcribed', 'c1')]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).not.toHaveBeenCalled();
  });

  it('zero chunks → finalizer does nothing', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(mockSessionUpdateStatus).not.toHaveBeenCalled();
  });

  it('session:status-changed is pushed on finalization', () => {
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([makeChunk('transcribed', 'c1')]);

    makeFinalizer().finalizeIfReady('sess-1');

    const call = vi.mocked(notifier.notify).mock.calls.find(
      ([, chan, payload]) =>
        chan === 'session:status-changed' &&
        (payload as { newStatus: SessionStatus }).newStatus === 'completed',
    );
    expect(call).toBeTruthy();
  });
});

describe('SessionFinalizer — audio retention (UNIT-058, UNIT-059, UNIT-059b)', () => {
  it('UNIT-058: keep_raw_audio=false + completed deletes recordings dir', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockSettingsGet.mockReturnValue(false); // keep_raw_audio=false
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([makeChunk('transcribed', 'c1')]);

    makeFinalizer().finalizeIfReady('sess-1');

    expect(fs.rmSync).toHaveBeenCalled();
    const [deletedPath] = vi.mocked(fs.rmSync).mock.calls[0] as [string];
    expect(String(deletedPath)).toContain('sess-1');
  });

  it('UNIT-059: keep_raw_audio=false + completed_with_failures → audio kept', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockSettingsGet.mockReturnValue(false); // keep_raw_audio=false
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([
      makeChunk('transcribed', 'c1'),
      makeChunk('permanently_failed', 'c2'),
    ]);

    makeFinalizer().finalizeIfReady('sess-1');

    // completed_with_failures → audio retained
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('UNIT-059b: keep_raw_audio=false + failed → audio force-retained', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockSettingsGet.mockReturnValue(false); // keep_raw_audio=false
    mockSessionFindById.mockReturnValue({ id: 'sess-1', status: 'processing' });
    mockChunkFindBySession.mockReturnValue([makeChunk('permanently_failed', 'c1')]);

    makeFinalizer().finalizeIfReady('sess-1');

    // failed → audio retained (force retain)
    expect(fs.rmSync).not.toHaveBeenCalled();
  });
});

// tests/integration/full-session-uploader.test.ts
// Suite I4 partial: FR-TR-2-FALLBACK path (INT-013, B-28)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../electron/ipc/notifier.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../electron/ipc/channels.js', () => ({
  PUSH_CHANNELS: {
    SESSION_STATUS_CHANGED: 'session:status-changed',
    ASR_PROVIDER_BANNER: 'asr:provider-banner',
  },
}));

import { runMigrations } from '../../electron/db/migration-runner.js';
import { SessionRepository } from '../../electron/db/session-repository.js';
import { ChunkRepository } from '../../electron/db/chunk-repository.js';
import { SegmentRepository } from '../../electron/db/segment-repository.js';
import { FullSessionUploader, ASR_MODE } from '../../electron/asr/full-session-uploader.js';
import * as notifier from '../../electron/ipc/notifier.js';

const stubWin = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
};

let db: BetterSqlite3.Database;
let sessionRepo: SessionRepository;
let chunkRepo: ChunkRepository;
let segmentRepo: SegmentRepository;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sessionRepo = new SessionRepository(db);
  chunkRepo = new ChunkRepository(db);
  segmentRepo = new SegmentRepository(db);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

function makeProvider() {
  return {
    uploadChunk: vi.fn(async () => 'https://upload-url/file.wav'),
    submitTranscript: vi.fn(async () => 'tx-fullsession-123'),
    pollTranscript: vi.fn(async () => ({
      status: 'completed',
      utterances: [
        { speaker: 'A', start: 0, end: 5000, text: 'Hello world' },
        { speaker: 'B', start: 5000, end: 10000, text: 'Hi there' },
      ],
    })),
    parseUtterances: vi.fn((r: { utterances?: Array<{ speaker: string; start: number; end: number; text: string }> }) =>
      (r.utterances ?? []).map(u => ({
        speakerLabel: u.speaker,
        startMs: u.start,
        endMs: u.end,
        text: u.text,
        confidence: null,
      }))
    ),
  };
}

function makeUploader(provider: ReturnType<typeof makeProvider>) {
  const finalizer = { finalizeIfReady: vi.fn() };
  const uploader = new FullSessionUploader(
    provider as never,
    sessionRepo,
    chunkRepo,
    segmentRepo,
    finalizer as never,
    stubWin as never,
  );
  return { uploader, finalizer };
}

describe('FullSessionUploader — FR-TR-2-FALLBACK (INT-013)', () => {
  it('ASR_MODE is accessible and is either "chunked" or "full-session"', () => {
    expect(['chunked', 'full-session']).toContain(ASR_MODE);
  });

  it('INT-013: with both mic and system chunks, exactly 2 uploads are made (one per stream)', async () => {
    const session = sessionRepo.create({ title: 'Full Session Test', source: 'both' });

    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/mic-0.wav',
      startSeconds: 0,
      endSeconds: 10,
    });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'system',
      seq: 0,
      filePath: '/tmp/system-0.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const provider = makeProvider();
    const { uploader } = makeUploader(provider);

    await uploader.uploadSession(session.id);

    expect(provider.uploadChunk).toHaveBeenCalledTimes(2);
    expect(provider.submitTranscript).toHaveBeenCalledTimes(2);
  });

  it('with only mic chunks, only 1 upload is made', async () => {
    const session = sessionRepo.create({ title: 'Mic Only', source: 'mic' });

    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/mic-0.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const provider = makeProvider();
    const { uploader } = makeUploader(provider);

    await uploader.uploadSession(session.id);

    expect(provider.uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('uploadSession with no chunks does nothing', async () => {
    const session = sessionRepo.create({ title: 'Empty Session', source: 'mic' });
    const provider = makeProvider();
    const { uploader } = makeUploader(provider);

    await uploader.uploadSession(session.id);

    expect(provider.uploadChunk).not.toHaveBeenCalled();
  });

  it('successful upload: chunk transitions to transcribed and segments are inserted', async () => {
    const session = sessionRepo.create({ title: 'Success Test', source: 'mic' });
    const chunk = chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/mic-0.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const provider = makeProvider();
    const { uploader, finalizer } = makeUploader(provider);

    await uploader.uploadSession(session.id);

    const updatedChunk = chunkRepo.findById(chunk.id);
    expect(updatedChunk!.status).toBe('transcribed');

    const segments = segmentRepo.findBySessionId(session.id);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every(s => s.speakerLabel === 'You')).toBe(true);
    expect(finalizer.finalizeIfReady).toHaveBeenCalledWith(session.id);
  });

  it('upload failure: chunk transitions to permanently_failed', async () => {
    const session = sessionRepo.create({ title: 'Failure Test', source: 'mic' });
    const chunk = chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/mic-0.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const failingProvider = makeProvider();
    failingProvider.uploadChunk.mockRejectedValue(new Error('Network error'));

    const { uploader } = makeUploader(failingProvider);

    await uploader.uploadSession(session.id);

    const updatedChunk = chunkRepo.findById(chunk.id);
    expect(updatedChunk!.status).toBe('permanently_failed');
  });

  it('processing notification is sent at start of uploadSession', async () => {
    const session = sessionRepo.create({ title: 'Notify Test', source: 'mic' });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/mic-0.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const provider = makeProvider();
    const { uploader } = makeUploader(provider);

    await uploader.uploadSession(session.id);

    const processingCall = vi.mocked(notifier.notify).mock.calls.find(
      ([, chan, payload]) =>
        chan === 'session:status-changed' &&
        (payload as { newStatus: string }).newStatus === 'processing',
    );
    expect(processingCall).toBeTruthy();
  });
});

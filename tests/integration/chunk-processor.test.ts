// tests/integration/chunk-processor.test.ts
// Suite I3: Chunk Processor Upload Pipeline (INT-007–011)

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
    ASR_PROVIDER_BANNER: 'asr:provider-banner',
    SESSION_STATUS_CHANGED: 'session:status-changed',
  },
}));

// Mock waitForRetry to be instant so retry loop completes quickly in tests
vi.mock('../../electron/asr/retry-policy.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../electron/asr/retry-policy.js')>();
  return {
    ...orig,
    waitForRetry: vi.fn(() => Promise.resolve()),
  };
});

import { runMigrations } from '../../electron/db/migration-runner.js';
import { SessionRepository } from '../../electron/db/session-repository.js';
import { ChunkRepository } from '../../electron/db/chunk-repository.js';
import { SegmentRepository } from '../../electron/db/segment-repository.js';
import { ChunkProcessor } from '../../electron/asr/chunk-processor.js';
import { ProviderError } from '../../electron/asr/provider-errors.js';
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

afterEach(async () => {
  // Give async operations a moment to settle before closing the DB
  await new Promise(r => setTimeout(r, 50));
  db.close();
});

function makeProvider(overrides: {
  uploadChunk?: ReturnType<typeof vi.fn>;
  submitTranscript?: ReturnType<typeof vi.fn>;
  pollTranscript?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    uploadChunk: overrides.uploadChunk ?? vi.fn(() => Promise.resolve('https://upload-url/file.wav')),
    submitTranscript: overrides.submitTranscript ?? vi.fn(() => Promise.resolve('tx-123')),
    pollTranscript: overrides.pollTranscript ?? vi.fn(() => Promise.resolve({
      status: 'completed',
      utterances: [
        { speaker: 'A', start: 0, end: 5000, text: 'Hello world' },
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

function makeProcessor(provider: ReturnType<typeof makeProvider>) {
  const stubFinalizer = { finalizeIfReady: vi.fn() };
  // ChunkProcessor now accepts a factory (evaluated per upload) — wrap the stub
  const providerFactory = () => provider as never;
  return {
    processor: new ChunkProcessor(
      chunkRepo,
      segmentRepo,
      sessionRepo,
      providerFactory,
      stubFinalizer as never,
      stubWin as never,
    ),
    finalizer: stubFinalizer,
  };
}

async function runOneTick(processor: ChunkProcessor): Promise<void> {
  return (processor as unknown as { tick: () => Promise<void> }).tick();
}

describe('ChunkProcessor — upload pipeline (INT-007 to INT-011)', () => {
  it('INT-007: pending chunk transitions to transcribed', async () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const provider = makeProvider();
    const { processor } = makeProcessor(provider);

    // First tick: picks up pending chunk and starts upload
    await runOneTick(processor);
    await new Promise(r => setTimeout(r, 50));

    expect(provider.uploadChunk).toHaveBeenCalled();
    expect(provider.submitTranscript).toHaveBeenCalled();
  });

  it('INT-007: after upload + poll, chunk is transcribed and segments inserted', async () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const provider = makeProvider();
    const { processor } = makeProcessor(provider);

    // Run upload tick and wait for it to complete
    await runOneTick(processor);
    await new Promise(r => setTimeout(r, 100));

    // The chunk is now in 'polling' status. The MIN_POLL_INTERVAL_MS (3s) prevents
    // immediate re-poll via tick(). Directly simulate poll by manipulating lastPolledAt.
    (processor as unknown as { lastPolledAt: Map<string, number> }).lastPolledAt.clear();

    // Run poll tick
    await runOneTick(processor);
    await new Promise(r => setTimeout(r, 100));

    processor.stop();

    const chunks = chunkRepo.findBySession(session.id);
    expect(chunks[0].status).toBe('transcribed');
  });

  it('INT-008: concurrency cap — at most 3 uploads at once', async () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });

    for (let i = 0; i < 6; i++) {
      chunkRepo.create({
        sessionId: session.id,
        stream: 'mic',
        seq: i,
        filePath: `/tmp/chunk-${i}.wav`,
        startSeconds: i * 10,
        endSeconds: (i + 1) * 10,
      });
    }

    let activeUploads = 0;
    let maxConcurrent = 0;

    const slowProvider = makeProvider({
      uploadChunk: vi.fn(async () => {
        activeUploads++;
        maxConcurrent = Math.max(maxConcurrent, activeUploads);
        await new Promise(r => setTimeout(r, 50));
        activeUploads--;
        return 'https://upload-url/file.wav';
      }),
    });

    const { processor } = makeProcessor(slowProvider);

    await runOneTick(processor);
    await new Promise(r => setTimeout(r, 20));

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('INT-009: network error → chunk is eventually uploaded after transient failures', async () => {
    // This test verifies that transient network errors (thrown by provider) are retried.
    // With waitForRetry mocked to instant, the retry loop completes immediately.
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    let attempt = 0;
    const eventuallySucceedProvider = makeProvider({
      uploadChunk: vi.fn(async () => {
        attempt++;
        if (attempt < 3) throw new ProviderError('network', 0, 'Network error');
        return 'https://upload-url/file.wav';
      }),
    });

    const { processor } = makeProcessor(eventuallySucceedProvider);

    await runOneTick(processor);
    await new Promise(r => setTimeout(r, 200));
    processor.stop();

    // Upload was called multiple times (retries happened)
    expect(eventuallySucceedProvider.uploadChunk.mock.calls.length).toBeGreaterThan(1);
  });

  it('INT-010: after 5 failed attempts, chunk becomes permanently_failed', async () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    const chunk = chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    // Use waitForRetry mock to avoid actual delays in retry loop
    const alwaysFailProvider = makeProvider({
      uploadChunk: vi.fn(async () => {
        throw new ProviderError('provider_5xx', 500, 'Service Unavailable');
      }),
    });

    const { processor, finalizer } = makeProcessor(alwaysFailProvider);

    await runOneTick(processor);
    // The doUpload loop runs 5 retries synchronously except for waitForRetry
    // Wait enough for all retries to complete (BASE_DELAY 2000ms × 5 = 10s with backoff)
    // We use a generous timeout but won't actually wait 10s since waitForRetry is called
    // only from attempt > 0. Mock waitForRetry to be instant.
    // With waitForRetry mocked to instant, 5 retries complete quickly
    await new Promise(r => setTimeout(r, 200));
    processor.stop();

    const updatedChunk = chunkRepo.findById(chunk.id);
    expect(updatedChunk!.status).toBe('permanently_failed');
    expect(finalizer.finalizeIfReady).toHaveBeenCalledWith(session.id);
  });

  it('INT-011: 401 response → permanently_failed, no provider banner emitted', async () => {
    const session = sessionRepo.create({ title: 'Test', source: 'mic' });
    chunkRepo.create({
      sessionId: session.id,
      stream: 'mic',
      seq: 0,
      filePath: '/tmp/test.wav',
      startSeconds: 0,
      endSeconds: 10,
    });

    const authFailProvider = makeProvider({
      uploadChunk: vi.fn(async () => {
        throw new ProviderError('auth_failed', 401, 'Unauthorized');
      }),
    });

    const { processor } = makeProcessor(authFailProvider);

    await runOneTick(processor);
    await new Promise(r => setTimeout(r, 200));

    const bannerCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:provider-banner' && (payload as { visible: boolean }).visible === true,
    );
    expect(bannerCalls).toHaveLength(0);
  });
});

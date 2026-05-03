// tests/unit/slow-uplink-badge.test.ts
// FR-TR-2 slow/metered network acceptance: ChunkProcessor emits asr:upload-slow badge
// when measured uplink throughput falls below 5 Mbps (625,000 bytes/sec).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../electron/ipc/notifier.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../electron/ipc/channels.js', () => ({
  PUSH_CHANNELS: {
    ASR_PROVIDER_BANNER: 'asr:provider-banner',
    ASR_UPLOAD_SLOW:     'asr:upload-slow',
    SESSION_STATUS_CHANGED: 'session:status-changed',
  },
}));

import { ChunkProcessor } from '../../electron/asr/chunk-processor.js';
import * as notifier from '../../electron/ipc/notifier.js';

// 5 Mbps = 625,000 bytes/sec.
// Tests use file sizes and durations that produce deterministic slow/fast results.
const SLOW_BYTES_PER_SEC = 625_000;   // threshold boundary
const FILE_1MB = 1_000_000;           // 1 MB — used to compute timing

/** Duration (ms) to simulate uploading FILE_1MB at a given bytes/sec rate */
function durationForRate(fileSizeBytes: number, bytesPerSec: number): number {
  return Math.ceil((fileSizeBytes / bytesPerSec) * 1000);
}

const stubWin = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
};

function makeProcessor() {
  const stubChunkRepo = {
    findPending: vi.fn(() => []),
    findInFlight: vi.fn(() => []),
    updateStatus: vi.fn(),
    incrementRetry: vi.fn(),
    setUploadUrl: vi.fn(),
    setTranscriptId: vi.fn(),
    findById: vi.fn(() => null),
  };
  const stubFinalizer = { finalizeIfReady: vi.fn() };
  const stubProvider = {
    uploadChunk: vi.fn(),
    submitTranscript: vi.fn(),
    pollTranscript: vi.fn(),
  };

  const processor = new ChunkProcessor(
    stubChunkRepo as never,
    {} as never,
    {} as never,
    () => stubProvider as never,
    stubFinalizer as never,
    stubWin as never,
  );
  return { processor };
}

function callRecordThroughput(
  processor: ChunkProcessor,
  fileSizeBytes: number,
  durationMs: number,
): void {
  (processor as unknown as {
    recordUploadThroughput(b: number, d: number): void
  }).recordUploadThroughput(fileSizeBytes, durationMs);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChunkProcessor — slow-uplink badge (FR-TR-2)', () => {
  it('no badge emitted for a single slow upload (below sustained-window threshold)', () => {
    const { processor } = makeProcessor();

    // 1 MB in 5 seconds = 200,000 bytes/sec — well below 5 Mbps
    callRecordThroughput(processor, FILE_1MB, durationForRate(FILE_1MB, 200_000));

    const slowCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan]) => chan === 'asr:upload-slow',
    );
    expect(slowCalls).toHaveLength(0);
  });

  it('no badge emitted for two consecutive slow uploads', () => {
    const { processor } = makeProcessor();
    const slowDuration = durationForRate(FILE_1MB, 200_000);

    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);

    const slowCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan]) => chan === 'asr:upload-slow',
    );
    expect(slowCalls).toHaveLength(0);
  });

  it('badge visible:true emitted after 3 consecutive slow uploads', () => {
    const { processor } = makeProcessor();
    // 1 MB in 10 seconds ≈ 100,000 bytes/sec — far below 5 Mbps
    const slowDuration = durationForRate(FILE_1MB, 100_000);

    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);

    const visibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:upload-slow' &&
        (payload as { visible: boolean }).visible === true,
    );
    expect(visibleCalls).toHaveLength(1);
    expect(visibleCalls[0][0]).toBe(stubWin);
    expect(visibleCalls[0][1]).toBe('asr:upload-slow');
  });

  it('badge fires only once for repeated slow uploads beyond the window', () => {
    const { processor } = makeProcessor();
    const slowDuration = durationForRate(FILE_1MB, 100_000);

    // 6 consecutive slow uploads
    for (let i = 0; i < 6; i++) {
      callRecordThroughput(processor, FILE_1MB, slowDuration);
    }

    const visibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:upload-slow' &&
        (payload as { visible: boolean }).visible === true,
    );
    // Should only fire once (not repeatedly)
    expect(visibleCalls).toHaveLength(1);
  });

  it('badge visible:false emitted after 3 consecutive fast uploads following slow period', () => {
    const { processor } = makeProcessor();
    const slowDuration = durationForRate(FILE_1MB, 100_000);
    // Fast: 1 MB in 100 ms ≈ 10 MB/sec — well above threshold
    const fastDuration = durationForRate(FILE_1MB, 10_000_000);

    // Trigger badge
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);

    vi.mocked(notifier.notify).mockClear();

    // Recover with 3 fast uploads
    callRecordThroughput(processor, FILE_1MB, fastDuration);
    callRecordThroughput(processor, FILE_1MB, fastDuration);
    callRecordThroughput(processor, FILE_1MB, fastDuration);

    expect(vi.mocked(notifier.notify)).toHaveBeenCalledWith(
      stubWin,
      'asr:upload-slow',
      { visible: false },
    );
  });

  it('badge does NOT clear before 3 consecutive fast uploads', () => {
    const { processor } = makeProcessor();
    const slowDuration = durationForRate(FILE_1MB, 100_000);
    const fastDuration = durationForRate(FILE_1MB, 10_000_000);

    // Trigger badge
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);

    vi.mocked(notifier.notify).mockClear();

    // Only 2 fast uploads — should NOT clear
    callRecordThroughput(processor, FILE_1MB, fastDuration);
    callRecordThroughput(processor, FILE_1MB, fastDuration);

    const clearCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:upload-slow' &&
        (payload as { visible: boolean }).visible === false,
    );
    expect(clearCalls).toHaveLength(0);
  });

  it('slow streak resets to zero after a fast upload', () => {
    const { processor } = makeProcessor();
    const slowDuration = durationForRate(FILE_1MB, 100_000);
    const fastDuration = durationForRate(FILE_1MB, 10_000_000);

    // 2 slow, then fast (no badge yet since < 3 slow)
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, fastDuration); // resets slow counter

    // 2 more slow — total is now 2 (not 4), so badge should NOT fire
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);

    const visibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:upload-slow' &&
        (payload as { visible: boolean }).visible === true,
    );
    expect(visibleCalls).toHaveLength(0);
  });

  it('zero file size does not trigger slow badge (ignores unknown size)', () => {
    const { processor } = makeProcessor();

    // Zero bytes — cannot determine throughput; should not count as slow
    callRecordThroughput(processor, 0, 10_000);
    callRecordThroughput(processor, 0, 10_000);
    callRecordThroughput(processor, 0, 10_000);

    const slowCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan]) => chan === 'asr:upload-slow',
    );
    expect(slowCalls).toHaveLength(0);
  });

  it('upload exactly at threshold boundary (625,000 bytes/sec) is not slow', () => {
    const { processor } = makeProcessor();
    // Exactly at threshold = not slow (must be strictly less than)
    const exactThresholdDuration = durationForRate(FILE_1MB, SLOW_BYTES_PER_SEC);

    for (let i = 0; i < 3; i++) {
      callRecordThroughput(processor, FILE_1MB, exactThresholdDuration);
    }

    const visibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:upload-slow' &&
        (payload as { visible: boolean }).visible === true,
    );
    // At exactly the threshold, bytesPerSec === SLOW_BYTES_PER_SEC which is NOT < threshold
    expect(visibleCalls).toHaveLength(0);
  });

  it('zero file size (stat failed) does not update either fast or slow counter (WARNING fix)', () => {
    const { processor } = makeProcessor();
    const slowDuration = durationForRate(FILE_1MB, 100_000);

    // Build up 2 slow uploads
    callRecordThroughput(processor, FILE_1MB, slowDuration);
    callRecordThroughput(processor, FILE_1MB, slowDuration);

    // A zero-size call should not count as fast (should not reset the slow counter)
    callRecordThroughput(processor, 0, 10_000); // stat failed — unknown size

    // Confirm the zero-size call was a no-op by completing the 3-slow window
    callRecordThroughput(processor, FILE_1MB, slowDuration); // 3rd slow → badge fires

    const visibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:upload-slow' &&
        (payload as { visible: boolean }).visible === true,
    );
    // Badge should have fired because zero-size did NOT reset the slow counter
    expect(visibleCalls).toHaveLength(1);
  });
});

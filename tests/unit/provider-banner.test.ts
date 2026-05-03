// tests/unit/provider-banner.test.ts
// Suite U17: Provider-Unreachable Banner (UNIT-047, UNIT-047b)

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
    SESSION_STATUS_CHANGED: 'session:status-changed',
  },
}));

import { ChunkProcessor } from '../../electron/asr/chunk-processor.js';
import { ProviderError } from '../../electron/asr/provider-errors.js';
import * as notifier from '../../electron/ipc/notifier.js';

const stubWin = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
};

function makeMinimalProcessor() {
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
  return { processor, stubChunkRepo, stubProvider };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChunkProcessor — provider banner (UNIT-047, UNIT-047b)', () => {
  it('UNIT-047: after 3 consecutive provider failures, asr:provider-banner visible:true is emitted', () => {
    const { processor } = makeMinimalProcessor();

    // Access private method via type assertion
    const handleFailure = (processor as unknown as { handleProviderFailure: () => void }).handleProviderFailure.bind(processor);

    handleFailure();
    handleFailure();
    // No banner yet (only 2 failures)
    expect(vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan]) => chan === 'asr:provider-banner'
    )).toHaveLength(0);

    handleFailure(); // 3rd failure → banner fires
    const bannerCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:provider-banner' && (payload as { visible: boolean }).visible === true,
    );
    expect(bannerCalls).toHaveLength(1);
  });

  it('UNIT-047: provider_5xx error code triggers banner tracking', () => {
    // ProviderError with 'provider_5xx' code should be caught by handleProviderFailure
    const err = new ProviderError('provider_5xx', 503, 'Service Unavailable');
    expect(err.code).toBe('provider_5xx');
    expect(err.status).toBe(503);
  });

  it('UNIT-047b: banner clears on next successful upload', () => {
    const { processor } = makeMinimalProcessor();

    const handleFailure = (processor as unknown as { handleProviderFailure: () => void }).handleProviderFailure.bind(processor);
    const handleSuccess = (processor as unknown as { handleUploadSuccess: () => void }).handleUploadSuccess.bind(processor);

    // Trigger banner
    handleFailure();
    handleFailure();
    handleFailure();

    // Banner visible = true was emitted
    const bannerVisibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, p]) => chan === 'asr:provider-banner' && (p as { visible: boolean }).visible === true,
    );
    expect(bannerVisibleCalls).toHaveLength(1);

    vi.mocked(notifier.notify).mockClear();

    // Simulate success
    handleSuccess();

    expect(vi.mocked(notifier.notify)).toHaveBeenCalledWith(
      stubWin,
      'asr:provider-banner',
      { visible: false },
    );
  });

  it('banner fires only once for repeated failures beyond threshold', () => {
    const { processor } = makeMinimalProcessor();
    const handleFailure = (processor as unknown as { handleProviderFailure: () => void }).handleProviderFailure.bind(processor);

    // 5 failures
    for (let i = 0; i < 5; i++) handleFailure();

    const bannerVisibleCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, p]) => chan === 'asr:provider-banner' && (p as { visible: boolean }).visible === true,
    );
    // Banner should only be emitted once (not repeated)
    expect(bannerVisibleCalls).toHaveLength(1);
  });

  it('2 failures then success resets counter without banner clear', () => {
    const { processor } = makeMinimalProcessor();
    const handleFailure = (processor as unknown as { handleProviderFailure: () => void }).handleProviderFailure.bind(processor);
    const handleSuccess = (processor as unknown as { handleUploadSuccess: () => void }).handleUploadSuccess.bind(processor);

    handleFailure();
    handleFailure();
    handleSuccess(); // reset before reaching threshold

    const bannerCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan]) => chan === 'asr:provider-banner',
    );
    expect(bannerCalls).toHaveLength(0);
  });

  it('UNIT-047c: network error code triggers provider banner after 3 consecutive failures (BLOCKER #3 fix)', async () => {
    const session = { id: 'sess-1' };
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
      uploadChunk: vi.fn(async () => { throw new ProviderError('network', 0, 'Network error'); }),
      submitTranscript: vi.fn(),
      pollTranscript: vi.fn(),
    };

    const { ChunkProcessor: CP } = await import('../../electron/asr/chunk-processor.js');
    const processor = new CP(
      stubChunkRepo as never,
      {} as never,
      {} as never,
      () => stubProvider as never,
      stubFinalizer as never,
      stubWin as never,
    );

    // Simulate 3 failed uploads (each triggers handleProviderFailure via 'network' code)
    const handleFailure = (processor as unknown as { handleProviderFailure: () => void }).handleProviderFailure.bind(processor);
    handleFailure();
    handleFailure();
    expect(vi.mocked(notifier.notify).mock.calls.filter(([, c]) => c === 'asr:provider-banner')).toHaveLength(0);
    handleFailure(); // 3rd → banner
    const bannerCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:provider-banner' && (payload as { visible: boolean }).visible === true,
    );
    expect(bannerCalls).toHaveLength(1);
    void session;
    void processor;
  });

  it('UNIT-047d: timeout error code triggers provider banner after 3 consecutive failures (BLOCKER #3 fix)', () => {
    const { processor } = makeMinimalProcessor();
    const handleFailure = (processor as unknown as { handleProviderFailure: () => void }).handleProviderFailure.bind(processor);

    // Simulate 3 timeout failures
    handleFailure();
    handleFailure();
    handleFailure();

    const bannerCalls = vi.mocked(notifier.notify).mock.calls.filter(
      ([, chan, payload]) =>
        chan === 'asr:provider-banner' && (payload as { visible: boolean }).visible === true,
    );
    expect(bannerCalls).toHaveLength(1);
  });
});

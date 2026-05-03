// tests/unit/nvidia-nim-client.test.ts
// Suite: NVIDIA NIM client unit tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

// ── Hoisted mocks (must be defined before vi.mock factory closures) ───────────
const { mockReadFile, mockUnlink, mockExecFileAsync, mockRecognize } = vi.hoisted(() => ({
  mockReadFile:      vi.fn(),
  mockUnlink:        vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockRecognize:     vi.fn(),
}));

// ── Mock @grpc/grpc-js ───────────────────────────────────────────────────────
vi.mock('@grpc/grpc-js', () => {
  function MockRivaSpeechRecognition() {
    return { Recognize: mockRecognize };
  }
  return {
    credentials: {
      createSsl: vi.fn(() => ({})),
    },
    Metadata: vi.fn().mockImplementation(function MockMetadata() {
      return { set: vi.fn() };
    }),
    loadPackageDefinition: vi.fn(() => ({
      nvidia: {
        riva: {
          asr: {
            RivaSpeechRecognition: MockRivaSpeechRecognition,
          },
        },
      },
    })),
  };
});

vi.mock('@grpc/proto-loader', () => ({
  loadSync: vi.fn(() => ({})),
}));

// ── Mock node:child_process ──────────────────────────────────────────────────
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// ── Mock node:util ───────────────────────────────────────────────────────────
vi.mock('node:util', () => ({
  promisify: vi.fn(() => mockExecFileAsync),
}));

// ── Mock node:fs (promises) ──────────────────────────────────────────────────
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    promises: {
      ...(actual as typeof import('node:fs')).promises,
      readFile: mockReadFile,
      unlink:   mockUnlink,
    },
  };
});

// ── wav mock — hoisted factory that the Reader class uses ─────────────────────
// We store a mutable ref so individual tests can swap out the implementation
const wavReaderImpls: Array<() => object> = [];

vi.mock('wav', () => {
  // Default implementation: emit format + data + end when end() is called
  function MockWavReader(this: {
    handlers: Record<string, Array<(...args: unknown[]) => void>>;
  }) {
    this.handlers = {};
  }
  MockWavReader.prototype.on = function(
    this: { handlers: Record<string, Array<(...args: unknown[]) => void>> },
    event: string,
    cb: (...args: unknown[]) => void,
  ) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(cb);
    return this;
  };
  MockWavReader.prototype.end = function(
    this: { handlers: Record<string, Array<(...args: unknown[]) => void>> },
    buf: Buffer,
  ) {
    // Check if a custom implementation was pushed
    if (wavReaderImpls.length > 0) {
      const impl = wavReaderImpls[wavReaderImpls.length - 1];
      impl.call(this);
      return;
    }
    // Default: pass through the buffer as-is (no header stripping)
    const emit = (evt: string, ...args: unknown[]) => {
      for (const cb of this.handlers[evt] ?? []) cb(...args);
    };
    emit('format', { sampleRate: 16000, channels: 1, bitDepth: 16 });
    emit('data', buf);
    emit('end');
  };
  MockWavReader.prototype.destroy = function() { /* noop */ };

  return { Reader: MockWavReader };
});

// ── Now import the module under test ─────────────────────────────────────────
import { NvidiaNimClient } from '../../electron/asr/nvidia-nim-client.js';

const TEST_PROTO_PATH = '/fake/riva_asr.proto';
const TEST_API_KEY    = 'nvapi-test-key';

function makeClient() {
  // Clear static caches so each test gets a fresh state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NvidiaNimClient as any).clientCache.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NvidiaNimClient as any).frames.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (NvidiaNimClient as any).jobs.clear();
  return new NvidiaNimClient(TEST_API_KEY, TEST_PROTO_PATH);
}

beforeEach(() => {
  vi.clearAllMocks();
  wavReaderImpls.length = 0;
  // Default: execFileAsync succeeds with empty output
  mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  // Default: unlink resolves
  mockUnlink.mockResolvedValue(undefined);
  // Default: readFile returns a small PCM buffer
  mockReadFile.mockResolvedValue(Buffer.from([0x01, 0x02]));
});

afterEach(() => {
  vi.restoreAllMocks();
  wavReaderImpls.length = 0;
});

// ── Test 1: max_alternatives === 1 ───────────────────────────────────────────

describe('max_alternatives is always 1', () => {
  it('submitTranscript sends config.max_alternatives === 1, never 0 or undefined', async () => {
    const client = makeClient();

    // Seed a fake uploadUrl directly into the static frames map
    const uploadUrl = 'nim://fake-uuid-1234';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NvidiaNimClient as any).frames.set(uploadUrl, {
      frames:     Buffer.from('pcm-data'),
      sampleRate: 16000,
    });

    // Capture config passed to Recognize
    let capturedConfig: Record<string, unknown> | null = null;
    mockRecognize.mockImplementation(
      (req: { config: Record<string, unknown> }, _meta: unknown, cb: (err: null, resp: unknown) => void) => {
        capturedConfig = req.config;
        cb(null, { results: [] });
      },
    );

    await client.submitTranscript(uploadUrl, { speakerLabels: false });

    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!['max_alternatives']).toBe(1);
    expect(capturedConfig!['max_alternatives']).not.toBe(0);
    expect(capturedConfig!['max_alternatives']).not.toBeUndefined();
  });
});

// ── Test 2: gRPC error → ProviderErrorCode mapping ───────────────────────────

describe('gRPC error code → ProviderErrorCode mapping', () => {
  const cases: Array<[number, string]> = [
    [16, 'auth_failed'],
    [7,  'auth_failed'],
    [8,  'rate_limited'],
    [3,  'bad_request'],
    [9,  'bad_request'],
    [13, 'provider_5xx'],
    [14, 'provider_5xx'],
    [4,  'timeout'],
    [1,  'timeout'],
    [99, 'unknown'],
  ];

  it.each(cases)('gRPC code %i → error contains %s', async (grpcCode, expectedCode) => {
    const client = makeClient();

    const uploadUrl = `nim://fake-uuid-${grpcCode}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (NvidiaNimClient as any).frames.set(uploadUrl, {
      frames:     Buffer.from('pcm'),
      sampleRate: 16000,
    });

    mockRecognize.mockImplementation(
      (_req: unknown, _meta: unknown, cb: (err: { code: number } | null, resp: unknown) => void) => {
        cb({ code: grpcCode }, null);
      },
    );

    const transcriptId = await client.submitTranscript(uploadUrl, {});
    // Wait for the promise to settle
    const result = await client.pollTranscript(transcriptId);

    expect(result.status).toBe('error');
    expect(result.error).toContain(expectedCode);
  });
});

// ── Test 3: WAV header strip ──────────────────────────────────────────────────

describe('WAV header stripping', () => {
  it('uploadChunk with .wav strips the WAV header, storing only PCM payload', async () => {
    const client = makeClient();

    // Build a minimal 44-byte RIFF WAV header + known PCM payload
    const pcmPayload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const wavHeader  = Buffer.alloc(44);
    wavHeader.write('RIFF', 0, 'ascii');
    wavHeader.write('WAVE', 8, 'ascii');
    const fullWavBuf = Buffer.concat([wavHeader, pcmPayload]);

    // Make readFile return the full WAV buffer
    mockReadFile.mockResolvedValue(fullWavBuf);

    // Push a custom wav.Reader implementation that emits only the PCM portion
    wavReaderImpls.push(function(this: {
      handlers: Record<string, Array<(...args: unknown[]) => void>>;
    }) {
      const emit = (evt: string, ...args: unknown[]) => {
        for (const cb of this.handlers[evt] ?? []) cb(...args);
      };
      emit('format', { sampleRate: 16000, channels: 1, bitDepth: 16 });
      emit('data', pcmPayload); // only PCM, no header
      emit('end');
    });

    const uploadUrl = await client.uploadChunk('/path/to/audio.wav');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = (NvidiaNimClient as any).frames.get(uploadUrl) as { frames: Buffer; sampleRate: number };
    expect(stored).toBeDefined();
    // The stored frames should be the PCM payload only — no WAV header bytes
    expect(stored.frames).toEqual(pcmPayload);
    expect(stored.frames.length).toBe(pcmPayload.length);
    // The full WAV buffer (header + PCM) should not match the stored frames
    expect(Buffer.compare(stored.frames, fullWavBuf)).not.toBe(0);
    expect(stored.sampleRate).toBe(16000);
  });
});

// ── Test 4: ffmpeg branch ─────────────────────────────────────────────────────

describe('ffmpeg decode branch (.webm input)', () => {
  it('calls ffmpeg with correct s16le args and unlinks tmp file on success', async () => {
    const client = makeClient();

    const fakePcm = Buffer.from([0xAA, 0xBB, 0xCC]);
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockReadFile.mockResolvedValue(fakePcm);

    await client.uploadChunk('/path/to/audio.webm');

    // Verify execFile was called with the right ffmpeg arguments
    expect(mockExecFileAsync).toHaveBeenCalledOnce();
    const [cmd, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('ffmpeg');
    expect(args).toContain('-f');
    expect(args).toContain('s16le');
    expect(args).toContain('-acodec');
    expect(args).toContain('pcm_s16le');
    expect(args).toContain('-ac');
    expect(args).toContain('1');
    expect(args).toContain('-ar');
    expect(args).toContain('16000');

    // Tmp file should have been unlinked
    expect(mockUnlink).toHaveBeenCalledOnce();
    const [unlinkedPath] = mockUnlink.mock.calls[0] as [string];
    expect(path.extname(unlinkedPath)).toBe('.pcm');
  });

  it('unlinks tmp file even when ffmpeg fails', async () => {
    const client = makeClient();

    mockExecFileAsync.mockRejectedValue(new Error('ffmpeg not found'));

    await expect(client.uploadChunk('/path/to/audio.webm')).rejects.toThrow();

    // Tmp file must be unlinked even on failure (finally block)
    expect(mockUnlink).toHaveBeenCalledOnce();
  });
});

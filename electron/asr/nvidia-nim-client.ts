// electron/asr/nvidia-nim-client.ts
// NVIDIA NIM Riva ASR gRPC provider implementing IASRProvider.
//
// Critical invariants (proven by test script):
// - max_alternatives MUST be 1 (proto3 default 0 = silent empty transcript)
// - WAV header must be stripped; send raw PCM frames only
// - Proto field numbers must match compiled Riva proto exactly (8/7/13/19)
// - WordInfo start_time/end_time are int32 milliseconds (NOT Duration)
// - Auth via per-call metadata: authorization + function-id

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as wav from 'wav';
import type {
  IASRProvider,
  RawUtterance,
  TranscribeOptions,
  TranscriptResult,
} from './provider-interface.js';
import { ProviderError, type ProviderErrorCode } from './provider-errors.js';

const execFileAsync = promisify(execFile);

// Function ID for openai/whisper-large-v3 on NVCF (supports 99 languages + auto-detect via "multi")
const NVIDIA_HOST    = 'grpc.nvcf.nvidia.com:443';
const FUNCTION_ID    = 'b702f636-f60c-4a3d-a6f4-f3568c13bd7d';
const MAX_CHUNK_BYTES = 50 * 1024 * 1024; // 50 MB PCM safety limit

// Job state — keyed by transcript ID
type JobEntry =
  | { state: 'pending'; promise: Promise<TranscriptResult> }
  | { state: 'done';    result: TranscriptResult };

// Riva response types (matching the proto field numbers exactly)
interface RivaWordInfo {
  word:        string;
  confidence:  number;
  speaker_tag: number;
  start_time:  number; // int32 ms
  end_time:    number; // int32 ms
}
interface RivaAlternative { transcript: string; confidence: number; words: RivaWordInfo[] }
interface RivaResult      { alternatives: RivaAlternative[] }
interface RivaResponse    { results: RivaResult[] }

function classifyGrpcError(code: number): ProviderErrorCode {
  switch (code) {
    case 16: // UNAUTHENTICATED
    case  7: // PERMISSION_DENIED
      return 'auth_failed';
    case 8:  // RESOURCE_EXHAUSTED
      return 'rate_limited';
    case 3:  // INVALID_ARGUMENT
    case 9:  // FAILED_PRECONDITION
    case 11: // OUT_OF_RANGE
      return 'bad_request';
    case 13: // INTERNAL
    case 14: // UNAVAILABLE
      return 'provider_5xx';
    case  4: // DEADLINE_EXCEEDED
    case  1: // CANCELLED
      return 'timeout';
    default:
      return 'unknown';
  }
}

function rivaToTranscriptResult(resp: RivaResponse, speakerLabels: boolean): TranscriptResult {
  const allWords = resp.results.flatMap(r => r.alternatives[0]?.words ?? []);

  if (allWords.length === 0) {
    // Fallback: use transcript strings with no word timestamps
    const text = resp.results
      .flatMap(r => r.alternatives[0]?.transcript ?? '')
      .join(' ')
      .trim();
    if (!text) return { status: 'completed', utterances: [] };
    return {
      status: 'completed',
      utterances: [{ speaker: '0', start: 0, end: 0, text, confidence: undefined }],
    };
  }

  if (!speakerLabels) {
    // Single utterance per result chunk
    const utterances = resp.results
      .filter(r => r.alternatives[0]?.transcript)
      .map(r => {
        const alt   = r.alternatives[0];
        const words = alt.words ?? [];
        return {
          speaker:    '0',
          start:      words[0]?.start_time ?? 0,
          end:        words[words.length - 1]?.end_time ?? 0,
          text:       alt.transcript,
          confidence: undefined as number | undefined,
        };
      });
    return { status: 'completed', utterances };
  }

  // Group consecutive words by speaker_tag into turns
  const turns: Array<{ speaker: number; words: RivaWordInfo[] }> = [];
  for (const w of allWords) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === w.speaker_tag) {
      last.words.push(w);
    } else {
      turns.push({ speaker: w.speaker_tag, words: [w] });
    }
  }

  const utterances = turns.map(turn => {
    const first = turn.words[0];
    const last  = turn.words[turn.words.length - 1];
    const avgConf = turn.words.reduce((s, w) => s + (w.confidence ?? 0), 0) / turn.words.length;
    return {
      speaker:    String(turn.speaker),
      start:      first.start_time,
      end:        last.end_time,
      text:       turn.words.map(w => w.word).join(' '),
      confidence: avgConf > 0 ? avgConf : undefined,
    };
  });

  return { status: 'completed', utterances };
}

export class NvidiaNimClient implements IASRProvider {
  readonly name = 'nvidia' as const;

  // Static maps survive the per-tick factory (new instance per call)
  private static readonly jobs   = new Map<string, JobEntry>();
  private static readonly frames = new Map<string, { frames: Buffer; sampleRate: number }>();

  // Shared gRPC client — lazy-initialized once per protoPath
  private static clientCache = new Map<string, unknown>();

  constructor(
    private readonly apiKey:    string,
    private readonly protoPath: string,
  ) {}

  private getClient(): unknown {
    const cached = NvidiaNimClient.clientCache.get(this.protoPath);
    if (cached) return cached;

    const pkgDef = protoLoader.loadSync(this.protoPath, {
      keepCase: true,
      longs:    Number,
      enums:    String,
      defaults: true,
      oneofs:   true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = grpc.loadPackageDefinition(pkgDef) as any;
    const RivaSpeechRecognition = pkg.nvidia.riva.asr.RivaSpeechRecognition;

    const client = new RivaSpeechRecognition(
      NVIDIA_HOST,
      grpc.credentials.createSsl(),
      {
        'grpc.max_send_message_length':    64 * 1024 * 1024,
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
      },
    );
    NvidiaNimClient.clientCache.set(this.protoPath, client);
    return client;
  }

  private buildCallMeta(): grpc.Metadata {
    const meta = new grpc.Metadata();
    meta.set('authorization', `Bearer ${this.apiKey}`);
    meta.set('function-id', FUNCTION_ID);
    return meta;
  }

  // ── uploadChunk ─────────────────────────────────────────────────────────────

  async uploadChunk(filePath: string, signal?: AbortSignal): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    let frames: Buffer;
    let sampleRate: number;

    if (ext === '.wav') {
      // Fast path: parse WAV header via wav.Reader, extract raw PCM frames
      ({ frames, sampleRate } = await this.readWavFrames(filePath, signal));
    } else {
      // Decode WebM/Opus or any other format via ffmpeg → raw s16le PCM
      ({ frames, sampleRate } = await this.decodeViaffmpeg(filePath, signal));
    }

    if (frames.length > MAX_CHUNK_BYTES) {
      throw new ProviderError('bad_request', null, 'chunk exceeds 50 MB PCM limit');
    }

    const uploadUrl = `nim://${randomUUID()}`;
    NvidiaNimClient.frames.set(uploadUrl, { frames, sampleRate });
    return uploadUrl;
  }

  private readWavFrames(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ frames: Buffer; sampleRate: number }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new ProviderError('timeout', null, 'aborted')); return; }

      const reader = new wav.Reader();
      const chunks: Buffer[] = [];
      let fmt: wav.Format | null = null;

      reader.on('format', (f: wav.Format) => { fmt = f; });
      reader.on('data',   (chunk: Buffer) => chunks.push(chunk));
      reader.on('end',    () => resolve({ frames: Buffer.concat(chunks), sampleRate: fmt?.sampleRate ?? 16000 }));
      reader.on('error',  reject);

      signal?.addEventListener('abort', () => { reader.destroy(); reject(new ProviderError('timeout', null, 'aborted')); });

      fsp.readFile(filePath).then(buf => { reader.end(buf); }).catch(reject);
    });
  }

  private async decodeViaffmpeg(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ frames: Buffer; sampleRate: number }> {
    const tmpPath = path.join(
      process.env['TEMP'] ?? '/tmp',
      `nim-${randomUUID()}.pcm`,
    );
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', filePath,
          '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000',
          tmpPath,
        ],
        { signal: signal as AbortSignal | undefined },
      );
      const frames = await fsp.readFile(tmpPath);
      return { frames, sampleRate: 16000 };
    } catch (err) {
      const isAbort = (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
      throw new ProviderError(isAbort ? 'timeout' : 'bad_request', null, 'audio decode failed');
    } finally {
      await fsp.unlink(tmpPath).catch(() => { /* ignore if already gone */ });
    }
  }

  // ── submitTranscript ─────────────────────────────────────────────────────────

  async submitTranscript(
    uploadUrl:  string,
    options:    TranscribeOptions,
  ): Promise<string> {
    const cached = NvidiaNimClient.frames.get(uploadUrl);
    if (!cached) {
      throw new ProviderError('unknown', null, 'no audio for upload URL');
    }

    const { frames, sampleRate } = cached;
    const transcriptId = randomUUID();

    const config = {
      encoding:                   1, // LINEAR_PCM
      sample_rate_hertz:          sampleRate,
      // 'multi' enables Whisper auto language detection across 99 languages
      language_code:              (options.languageCode ?? 'multi').replace('_', '-'),
      max_alternatives:           1, // CRITICAL: proto3 default 0 = empty transcript
      enable_automatic_punctuation: true,
      enable_word_time_offsets:   true,
      ...(options.speakerLabels
        ? { diarization_config: { enable_speaker_diarization: true, max_speaker_count: 8 } }
        : {}),
    };

    const speakerLabels = options.speakerLabels ?? false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.getClient() as any;
    const callMeta = this.buildCallMeta();

    const promise: Promise<TranscriptResult> = new Promise((resolve) => {
      client.Recognize(
        { config, audio: frames },
        callMeta,
        (err: grpc.ServiceError | null, resp: RivaResponse) => {
          if (err) {
            const code = classifyGrpcError(err.code ?? 0);
            resolve({ status: 'error', error: `nvidia:${code}` });
          } else {
            resolve(rivaToTranscriptResult(resp, speakerLabels));
          }
        },
      );
    }).then(result => {
      NvidiaNimClient.jobs.set(transcriptId, { state: 'done', result });
      NvidiaNimClient.frames.delete(uploadUrl);
      return result;
    });

    NvidiaNimClient.jobs.set(transcriptId, { state: 'pending', promise });
    return transcriptId;
  }

  // ── pollTranscript ───────────────────────────────────────────────────────────

  async pollTranscript(
    transcriptId: string,
    signal?:      AbortSignal,
  ): Promise<TranscriptResult> {
    const entry = NvidiaNimClient.jobs.get(transcriptId);
    if (!entry) return { status: 'error', error: 'no_job' };

    if (entry.state === 'done') {
      // Schedule cleanup after successful delivery
      setTimeout(() => NvidiaNimClient.jobs.delete(transcriptId), 60_000);
      return entry.result;
    }

    // Pending: race against the caller's abort signal
    if (signal?.aborted) return { status: 'processing' };

    const abortRace = new Promise<TranscriptResult>(resolve => {
      signal?.addEventListener('abort', () => resolve({ status: 'processing' }), { once: true });
    });

    const result = await Promise.race([entry.promise, abortRace]);
    return result;
  }

  // ── parseUtterances ──────────────────────────────────────────────────────────

  parseUtterances(result: TranscriptResult): RawUtterance[] {
    if (!result.utterances) return [];
    return result.utterances.map(u => ({
      speakerLabel: u.speaker,
      startMs:      u.start,
      endMs:        u.end,
      text:         u.text,
      confidence:   u.confidence ?? null,
    }));
  }

  // ── testConnection ───────────────────────────────────────────────────────────

  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    // Send 0.5 s of silent 16 kHz mono PCM (16000 zero-bytes)
    const silentFrames = Buffer.alloc(16000);
    const config = {
      encoding:                   1,
      sample_rate_hertz:          16000,
      language_code:              'en-US',
      max_alternatives:           1,
      enable_automatic_punctuation: false,
      enable_word_time_offsets:   false,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.getClient() as any;
    const callMeta = this.buildCallMeta();

    return new Promise(resolve => {
      const timeoutSignal = AbortSignal.timeout(10_000);
      const combined = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      combined.addEventListener('abort', () => resolve({ ok: false, error: 'timeout' }));

      client.Recognize(
        { config, audio: silentFrames },
        callMeta,
        (err: grpc.ServiceError | null) => {
          if (err) {
            const code = classifyGrpcError(err.code ?? 0);
            resolve({ ok: false, error: code });
          } else {
            resolve({ ok: true });
          }
        },
      );
    });
  }
}

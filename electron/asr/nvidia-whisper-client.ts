// electron/asr/nvidia-whisper-client.ts
// NVIDIA NIM Whisper Large V3 provider implementing IASRProvider.
// Uses the OpenAI-compatible REST API at ai.api.nvidia.com.
//
// Key differences from nvidia-nim-client.ts (Riva gRPC):
// - REST multipart/form-data, not gRPC
// - Supports 99+ languages with automatic language detection (language=auto)
// - No speaker diarization — segments mapped to single speaker '0'
// - Synchronous call: uploadChunk stores the buffer, submitTranscript fires the
//   HTTP request and caches the promise, pollTranscript waits for it.

import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as wav from 'wav';
import type {
  IASRProvider,
  RawUtterance,
  TranscribeOptions,
  TranscriptResult,
} from './provider-interface.js';
import { ProviderError } from './provider-errors.js';

const WHISPER_ENDPOINT = 'https://integrate.api.nvidia.com/v1/audio/transcriptions';
const WHISPER_MODEL    = 'openai/whisper-large-v3';
const MAX_CHUNK_BYTES  = 25 * 1024 * 1024; // 25 MB WAV safety limit

type JobEntry =
  | { state: 'pending'; promise: Promise<TranscriptResult> }
  | { state: 'done';    result: TranscriptResult };

interface WhisperSegment {
  id:    number;
  start: number; // seconds (float)
  end:   number; // seconds (float)
  text:  string;
}

interface WhisperVerboseResponse {
  text:     string;
  language: string;
  segments: WhisperSegment[];
}

function whisperToTranscriptResult(resp: WhisperVerboseResponse): TranscriptResult {
  if (!resp.segments || resp.segments.length === 0) {
    const text = (resp.text ?? '').trim();
    if (!text) return { status: 'completed', utterances: [] };
    return {
      status: 'completed',
      utterances: [{ speaker: '0', start: 0, end: 0, text, confidence: undefined }],
    };
  }

  const utterances = resp.segments
    .filter(s => s.text.trim())
    .map(s => ({
      speaker:    '0',
      start:      Math.round(s.start * 1000), // ms
      end:        Math.round(s.end   * 1000), // ms
      text:       s.text.trim(),
      confidence: undefined as number | undefined,
    }));

  return { status: 'completed', utterances };
}

export class NvidiaWhisperClient implements IASRProvider {
  readonly name = 'nvidia' as const;

  private static readonly jobs   = new Map<string, JobEntry>();
  private static readonly buffers = new Map<string, Buffer>();

  constructor(private readonly apiKey: string) {}

  // ── uploadChunk ─────────────────────────────────────────────────────────────

  async uploadChunk(filePath: string, signal?: AbortSignal): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    let wavBuffer: Buffer;
    if (ext === '.wav') {
      wavBuffer = await fsp.readFile(filePath);
    } else {
      throw new ProviderError('bad_request', null, 'only .wav files supported by whisper client');
    }

    if (wavBuffer.length > MAX_CHUNK_BYTES) {
      throw new ProviderError('bad_request', null, 'chunk exceeds 25 MB WAV limit');
    }

    if (signal?.aborted) throw new ProviderError('timeout', null, 'aborted');

    const uploadUrl = `nim-whisper://${randomUUID()}`;
    NvidiaWhisperClient.buffers.set(uploadUrl, wavBuffer);
    return uploadUrl;
  }

  // ── submitTranscript ─────────────────────────────────────────────────────────

  async submitTranscript(
    uploadUrl: string,
    options:   TranscribeOptions,
    signal?:   AbortSignal,
  ): Promise<string> {
    const wavBuffer = NvidiaWhisperClient.buffers.get(uploadUrl);
    if (!wavBuffer) {
      throw new ProviderError('unknown', null, 'no audio for upload URL');
    }

    const transcriptId = randomUUID();

    const promise: Promise<TranscriptResult> = this.callWhisperApi(wavBuffer, options, signal)
      .then(result => {
        NvidiaWhisperClient.jobs.set(transcriptId, { state: 'done', result });
        NvidiaWhisperClient.buffers.delete(uploadUrl);
        return result;
      })
      .catch(err => {
        const result: TranscriptResult = {
          status: 'error',
          error: err instanceof ProviderError ? `whisper:${err.code}` : 'whisper:unknown',
        };
        NvidiaWhisperClient.jobs.set(transcriptId, { state: 'done', result });
        NvidiaWhisperClient.buffers.delete(uploadUrl);
        return result;
      });

    NvidiaWhisperClient.jobs.set(transcriptId, { state: 'pending', promise });
    return transcriptId;
  }

  private async callWhisperApi(
    wavBuffer: Buffer,
    options:   TranscribeOptions,
    signal?:   AbortSignal,
  ): Promise<TranscriptResult> {
    // Read WAV to confirm it's valid audio before uploading
    const wavFrames = await this.readWavFrames(wavBuffer);
    if (wavFrames.byteLength === 0) {
      return { status: 'completed', utterances: [] };
    }

    const form = new FormData();
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    // 'auto' triggers Whisper's built-in language detection
    const lang = (options.languageCode ?? 'auto').replace('_', '-');
    form.append('language', lang === 'en-us' || lang === 'en-US' ? 'en' : lang);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form.append('file', new Blob([wavBuffer as any], { type: 'audio/wav' }), 'audio.wav');

    let resp: Response;
    try {
      const timeout = AbortSignal.timeout(60_000); // 60 s hard limit per chunk
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      resp = await fetch(WHISPER_ENDPOINT, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        body:    form,
        signal:  combined as AbortSignal,
      });
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      throw new ProviderError(isAbort ? 'timeout' : 'network', null, String(err));
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        throw new ProviderError('auth_failed', resp.status, body);
      }
      if (resp.status === 429) {
        throw new ProviderError('rate_limited', resp.status, body);
      }
      if (resp.status >= 500) {
        throw new ProviderError('provider_5xx', resp.status, body);
      }
      throw new ProviderError('bad_request', resp.status, body);
    }

    const json = await resp.json() as WhisperVerboseResponse;
    return whisperToTranscriptResult(json);
  }

  private readWavFrames(wavBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const reader = new wav.Reader();
      const chunks: Buffer[] = [];
      reader.on('data',  (c: Buffer) => chunks.push(c));
      reader.on('end',   () => resolve(Buffer.concat(chunks)));
      reader.on('error', reject);
      reader.end(wavBuffer);
    });
  }

  // ── pollTranscript ───────────────────────────────────────────────────────────

  async pollTranscript(transcriptId: string, signal?: AbortSignal): Promise<TranscriptResult> {
    const entry = NvidiaWhisperClient.jobs.get(transcriptId);
    if (!entry) return { status: 'error', error: 'no_job' };

    if (entry.state === 'done') {
      setTimeout(() => NvidiaWhisperClient.jobs.delete(transcriptId), 60_000);
      return entry.result;
    }

    if (signal?.aborted) return { status: 'processing' };

    const abortRace = new Promise<TranscriptResult>(resolve => {
      signal?.addEventListener('abort', () => resolve({ status: 'processing' }), { once: true });
    });

    return Promise.race([entry.promise, abortRace]);
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

  async testConnection(_signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    // Send 0.5 s of silent 16 kHz mono 16-bit PCM as a WAV
    const pcm     = Buffer.alloc(16000); // 0.5 s × 16000 Hz × 2 bytes = 16000 bytes
    const header  = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);   // PCM
    header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); // mono 16kHz
    header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); // byteRate blockAlign
    header.writeUInt16LE(16, 34);                                   // 16-bit
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    const silentWav = Buffer.concat([header, pcm]);

    const form = new FormData();
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');
    form.append('language', 'en');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form.append('file', new Blob([silentWav as any], { type: 'audio/wav' }), 'silent.wav');

    try {
      const resp = await fetch(WHISPER_ENDPOINT, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        body:    form,
        signal:  AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { ok: false, error: `http_${resp.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

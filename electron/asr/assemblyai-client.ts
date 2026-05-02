// electron/asr/assemblyai-client.ts
// AssemblyAI HTTP client implementing IASRProvider.
// Security contracts per §4.4.1:
// - redirect:'manual' on every fetch
// - No raw response body in errors or logs
// - No Authorization header value in any logging path
// - Per-call timeout via AbortSignal.timeout

import { promises as fsp } from 'node:fs';
import type { IASRProvider, RawUtterance, TranscribeOptions, TranscriptResult } from './provider-interface.js';
import {
  ProviderError,
  classifyStatus,
  classifyHttpError,
  sanitizeProviderBody,
} from './provider-errors.js';

const UPLOAD_TIMEOUT_MS = 30_000;
const SUBMIT_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS   = 10_000;
const MAX_CHUNK_BYTES   = 5 * 1024 * 1024; // 5 MB

const BASE_URL = 'https://api.assemblyai.com/v2';

export class AssemblyAIClient implements IASRProvider {
  readonly name = 'assemblyai' as const;

  constructor(private readonly apiKey: string) {}

  /**
   * Build Authorization header lazily. The string `this.apiKey` appears ONLY here.
   * No other code path may read or log this.apiKey.
   */
  private authHeaders(extra: Record<string, string> = {}): HeadersInit {
    return { Authorization: this.apiKey, ...extra };
  }

  /**
   * Core fetch wrapper:
   * - redirect:'manual' prevents header replay on 3xx
   * - rejects 3xx explicitly
   * - maps non-2xx to ProviderError with sanitized body
   * - composes per-call timeout with optional caller AbortSignal
   */
  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: 'manual', signal });
    } catch (err) {
      throw new ProviderError(classifyHttpError(err), null, '');
    }

    // Reject 3xx — redirect:'manual' surfaces cross-origin as type:'opaqueredirect' (status 0)
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new ProviderError(
        'redirect_rejected',
        res.status || null,
        'AssemblyAI returned 3xx; redirects are not followed (key-leak prevention).',
      );
    }

    if (!res.ok) {
      const code = classifyStatus(res.status);
      const safeMessage = await sanitizeProviderBody(res);
      throw new ProviderError(code, res.status, safeMessage);
    }

    return res;
  }

  async uploadChunk(filePath: string, signal?: AbortSignal): Promise<string> {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_CHUNK_BYTES) {
      throw new ProviderError(
        'bad_request',
        null,
        `chunk exceeds ${MAX_CHUNK_BYTES} bytes`,
      );
    }
    // Buffer path (not ReadableStream) — simpler, ≤ 5 MB by precondition
    const body = await fsp.readFile(filePath);
    const res = await this.request(
      `${BASE_URL}/upload`,
      { method: 'POST', headers: this.authHeaders(), body },
      UPLOAD_TIMEOUT_MS,
      signal,
    );
    const json = (await res.json()) as { upload_url: string };
    return json.upload_url;
  }

  async submitTranscript(
    audioUrl: string,
    options: TranscribeOptions = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.request(
      `${BASE_URL}/transcript`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          audio_url: audioUrl,
          speaker_labels: options.speakerLabels ?? true,
          language_code: options.languageCode ?? 'en_us',
        }),
      },
      SUBMIT_TIMEOUT_MS,
      signal,
    );
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  async pollTranscript(
    transcriptId: string,
    signal?: AbortSignal,
  ): Promise<TranscriptResult> {
    const res = await this.request(
      `${BASE_URL}/transcript/${transcriptId}`,
      { headers: this.authHeaders() },
      POLL_TIMEOUT_MS,
      signal,
    );
    return (await res.json()) as TranscriptResult;
  }

  parseUtterances(result: TranscriptResult): RawUtterance[] {
    if (!result.utterances) return [];
    return result.utterances.map(u => ({
      speakerLabel: u.speaker,
      startMs: u.start,
      endMs: u.end,
      text: u.text,
      confidence: u.confidence ?? null,
    }));
  }

  /** Test connection with minimal API call — check if key is valid */
  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    try {
      // Use list endpoint as a lightweight auth check
      const res = await this.request(
        `${BASE_URL}/transcript?limit=1`,
        { headers: this.authHeaders() },
        10_000,
        signal,
      );
      await res.json(); // consume body
      return { ok: true };
    } catch (err) {
      if (err instanceof ProviderError) {
        return { ok: false, error: err.code };
      }
      return { ok: false, error: 'network' };
    }
  }
}

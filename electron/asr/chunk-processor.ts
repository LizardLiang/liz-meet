// electron/asr/chunk-processor.ts
// 2-second DB polling loop for chunk upload and transcript polling.
// Implements §4.3 of the tech spec with Promise.allSettled + per-chunk lastPolledAt.

import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SegmentRepository } from '../db/segment-repository.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { IASRProvider, RawUtterance } from './provider-interface.js';
import type { SessionFinalizer } from './session-finalizer.js';
import type { BrowserWindow } from 'electron';
import type { Chunk, Stream } from '../../src/types/liz-transcribe.js';
import { statSync } from 'node:fs';
import { ProviderError } from './provider-errors.js';
import { shouldRetry, waitForRetry } from './retry-policy.js';
import { notify } from '../ipc/notifier.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import { logger } from '../logging/logger.js';
import { classifyHttpError } from './provider-errors.js';

/** Factory that returns a fresh IASRProvider on each call. */
export type ProviderFactory = () => IASRProvider;

const TICK_INTERVAL_MS     = 2_000;   // L3: 2 s DB poll
const MIN_POLL_INTERVAL_MS = 3_000;   // per-chunk transcript-poll cadence
const POLL_HTTP_TIMEOUT_MS = 10_000;  // per-call HTTP timeout
const UPLOAD_CONCURRENCY   = Number(process.env['LIZMEET_UPLOAD_CONCURRENCY'] ?? 3);
const PROVIDER_UNREACHABLE_THRESHOLD = 3;

// Slow-network badge (FR-TR-2): "Uploading slowly" when sustained uplink < 5 Mbps.
// 5 Mbps = 625,000 bytes/second.
const SLOW_UPLINK_BYTES_PER_SEC = 625_000;  // 5 Mbps in bytes/sec
const SLOW_UPLINK_WINDOW        = 3;        // consecutive slow uploads before badge shown
const SLOW_UPLINK_CLEAR_WINDOW  = 3;        // consecutive fast uploads to clear badge

export class ChunkProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** chunkId → AbortController for the currently in-flight upload */
  private uploads = new Map<string, AbortController>();
  /** chunkId → epoch-ms of last GET /transcript/:id poll */
  private lastPolledAt = new Map<string, number>();
  /** Consecutive 5xx failures for provider-unreachable banner */
  private consecutiveFailed = 0;
  private providerBannerVisible = false;
  /** 429 throttle: epoch-ms until which we throttle */
  private throttleUntil = 0;
  /** Slow-uplink badge tracking (FR-TR-2) */
  private consecutiveSlowUploads = 0;
  private consecutiveFastUploads = 0;
  private slowBadgeVisible = false;

  constructor(
    private chunkRepo: ChunkRepository,
    private segmentRepo: SegmentRepository,
    private readonly _sessionRepo: SessionRepository,
    private providerFactory: ProviderFactory,
    private finalizer: SessionFinalizer,
    private win: BrowserWindow,
  ) {
    void this._sessionRepo; // reserved for future use
  }

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        logger.error({ event: 'tick_failed', code: 'tick_unhandled' });
      });
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Abort all in-flight uploads
    for (const ctrl of this.uploads.values()) {
      ctrl.abort();
    }
    this.uploads.clear();
  }

  private async tick(): Promise<void> {
    // 1. Kick off pending uploads (bounded by UPLOAD_CONCURRENCY)
    const slotsFree = Math.max(0, UPLOAD_CONCURRENCY - this.uploads.size);
    if (slotsFree > 0 && Date.now() > this.throttleUntil) {
      const pending = this.chunkRepo.findPending(slotsFree);
      for (const chunk of pending) {
        this.beginUpload(chunk);
      }
    }

    // 2. Poll in-flight transcripts (parallel, rate-limited per chunk)
    const polling = this.chunkRepo.findInFlight(50);
    const now = Date.now();
    const due = polling.filter(c => {
      const last = this.lastPolledAt.get(c.id) ?? 0;
      return now - last >= MIN_POLL_INTERVAL_MS;
    });

    // Promise.allSettled so one stuck poll cannot starve others
    await Promise.allSettled(
      due.map(chunk => {
        this.lastPolledAt.set(chunk.id, now);
        return this.pollTranscript(chunk);
      }),
    );

    // Garbage-collect lastPolledAt entries for chunks no longer in-flight
    if (this.lastPolledAt.size > polling.length * 2) {
      const live = new Set(polling.map(c => c.id));
      for (const k of this.lastPolledAt.keys()) {
        if (!live.has(k)) this.lastPolledAt.delete(k);
      }
    }
  }

  private beginUpload(chunk: Chunk): void {
    const ctrl = new AbortController();
    this.uploads.set(chunk.id, ctrl);
    this.chunkRepo.updateStatus(chunk.id, 'uploading');

    this.doUpload(chunk, ctrl.signal).finally(() => {
      this.uploads.delete(chunk.id);
    });
  }

  private async doUpload(chunk: Chunk, signal: AbortSignal): Promise<void> {
    let attempt = chunk.retryCount;

    while (attempt < 5) {
      try {
        if (attempt > 0) await waitForRetry(attempt);

        // Resolve provider on each attempt so that a key set after bootstrap is used.
        const provider = this.providerFactory();

        // Measure file size for uplink-speed badge (FR-TR-2)
        let fileSizeBytes = 0;
        try { fileSizeBytes = statSync(chunk.filePath).size; } catch { /* file may not exist in tests */ }
        const uploadStart = Date.now();

        const uploadUrl = await provider.uploadChunk(chunk.filePath, signal);
        this.chunkRepo.setUploadUrl(chunk.id, uploadUrl);

        // Record upload throughput after first attempt
        const uploadDurationMs = Math.max(1, Date.now() - uploadStart);
        this.recordUploadThroughput(fileSizeBytes, uploadDurationMs);

        const transcriptId = await provider.submitTranscript(
          uploadUrl,
          { speakerLabels: true, languageCode: 'en_us' },
          signal,
        );
        this.chunkRepo.setTranscriptId(chunk.id, transcriptId);

        // Success — reset consecutive failures counter
        this.handleUploadSuccess();
        return;
      } catch (err) {
        attempt++;
        this.chunkRepo.incrementRetry(chunk.id);

        const provErr = err instanceof ProviderError ? err : null;
        const statusCode = provErr?.status ?? 0;

        // Count provider-unreachable codes for banner (5xx, network flapping, DNS/timeout)
        if (provErr && (provErr.code === 'provider_5xx' || provErr.code === 'network' || provErr.code === 'timeout')) {
          this.handleProviderFailure();
        }

        if (!shouldRetry(statusCode, attempt)) {
          this.chunkRepo.updateStatus(chunk.id, 'permanently_failed', provErr?.code ?? 'unknown');
          this.finalizer.finalizeIfReady(chunk.sessionId);
          logger.warn({ event: 'chunk_permanently_failed', chunkId: chunk.id, code: provErr?.code });
          return;
        }

        this.chunkRepo.updateStatus(chunk.id, 'failed', provErr?.code ?? 'unknown');
        logger.warn({ event: 'chunk_upload_failed', chunkId: chunk.id, attempt, code: classifyHttpError(err) });
      }
    }

    // Exhausted retries
    this.chunkRepo.updateStatus(chunk.id, 'permanently_failed');
    this.finalizer.finalizeIfReady(chunk.sessionId);
  }

  private async pollTranscript(chunk: Chunk): Promise<void> {
    const signal = AbortSignal.timeout(POLL_HTTP_TIMEOUT_MS);
    try {
      const provider = this.providerFactory();
      const result = await provider.pollTranscript(chunk.transcriptId!, signal);

      if (result.status === 'completed') {
        await this.handleTranscribed(chunk, result.utterances ?? []);
      } else if (result.status === 'error') {
        await this.handleTranscriptError(chunk, result.error ?? 'unknown_provider_error');
      }
      // status === 'queued' | 'processing' → no-op; next tick will re-poll
    } catch (err) {
      // Network/timeout — do NOT mark chunk failed; just log and retry next tick
      logger.warn({
        event: 'poll_transient_error',
        chunkId: chunk.id,
        code: classifyHttpError(err),
      });
    }
  }

  private async handleTranscribed(
    chunk: Chunk,
    utterances: Array<{ speaker: string; start: number; end: number; text: string; confidence?: number }>,
  ): Promise<void> {
    // Parse and insert segments
    const rawUtterances: RawUtterance[] = utterances.map(u => ({
      speakerLabel: u.speaker,
      startMs: u.start,
      endMs: u.end,
      text: u.text,
      confidence: u.confidence ?? null,
    }));

    if (rawUtterances.length > 0) {
      const stream: Stream = chunk.stream;
      this.segmentRepo.bulkInsert(
        rawUtterances.map(u => ({
          sessionId: chunk.sessionId,
          chunkId: chunk.id,
          stream,
          speakerLabel: stream === 'mic' ? 'You' : u.speakerLabel,
          startSeconds: u.startMs / 1000,
          endSeconds: u.endMs / 1000,
          text: u.text,
          confidence: u.confidence,
          isFailedPlaceholder: false,
        })),
      );
    }

    this.chunkRepo.updateStatus(chunk.id, 'transcribed');
    this.finalizer.finalizeIfReady(chunk.sessionId);

    logger.info({ event: 'chunk_transcribed', chunkId: chunk.id, sessionId: chunk.sessionId });
  }

  private async handleTranscriptError(chunk: Chunk, error: string): Promise<void> {
    void error; // logged at caller level; stable error code only
    this.chunkRepo.incrementRetry(chunk.id);
    const updatedChunk = this.chunkRepo.findById(chunk.id);
    const newAttempt = updatedChunk?.retryCount ?? 5;

    if (!shouldRetry(500, newAttempt)) {
      this.chunkRepo.updateStatus(chunk.id, 'permanently_failed', 'provider_error');
      this.finalizer.finalizeIfReady(chunk.sessionId);
    } else {
      this.chunkRepo.updateStatus(chunk.id, 'failed', 'provider_error');
    }
  }

  private handleUploadSuccess(): void {
    if (this.consecutiveFailed > 0) {
      this.consecutiveFailed = 0;
      if (this.providerBannerVisible) {
        this.providerBannerVisible = false;
        notify(this.win, PUSH_CHANNELS.ASR_PROVIDER_BANNER, { visible: false });
      }
    }
  }

  private handleProviderFailure(): void {
    this.consecutiveFailed++;
    if (
      this.consecutiveFailed >= PROVIDER_UNREACHABLE_THRESHOLD &&
      !this.providerBannerVisible
    ) {
      this.providerBannerVisible = true;
      notify(this.win, PUSH_CHANNELS.ASR_PROVIDER_BANNER, { visible: true });
    }
  }

  /**
   * Record the throughput of a completed upload and update the slow-uplink badge.
   * FR-TR-2: emit ASR_UPLOAD_SLOW when sustained uplink < 5 Mbps.
   */
  recordUploadThroughput(fileSizeBytes: number, durationMs: number): void {
    if (fileSizeBytes <= 0) return; // unknown size (stat failed) — don't update either counter
    const bytesPerSec = (fileSizeBytes / durationMs) * 1000;
    const isSlow = bytesPerSec < SLOW_UPLINK_BYTES_PER_SEC;

    if (isSlow) {
      this.consecutiveSlowUploads++;
      this.consecutiveFastUploads = 0;
      if (
        this.consecutiveSlowUploads >= SLOW_UPLINK_WINDOW &&
        !this.slowBadgeVisible
      ) {
        this.slowBadgeVisible = true;
        notify(this.win, PUSH_CHANNELS.ASR_UPLOAD_SLOW, { visible: true });
        logger.warn({
          event: 'slow_uplink_detected',
          bytesPerSec: Math.round(bytesPerSec),
          fileSizeBytes,
          durationMs,
        });
      }
    } else {
      this.consecutiveFastUploads++;
      this.consecutiveSlowUploads = 0;
      if (
        this.consecutiveFastUploads >= SLOW_UPLINK_CLEAR_WINDOW &&
        this.slowBadgeVisible
      ) {
        this.slowBadgeVisible = false;
        this.consecutiveFastUploads = 0;
        notify(this.win, PUSH_CHANNELS.ASR_UPLOAD_SLOW, { visible: false });
      }
    }
  }
}

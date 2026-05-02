// electron/asr/full-session-uploader.ts
// FR-TR-2-FALLBACK: Full-session upload path.
// Activated when LIZMEET_ASR_MODE='full-session' (§11.5.4 exit gate FAIL).
// Default mode is 'chunked'; this is built but feature-flagged.

import type { IASRProvider } from './provider-interface.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SegmentRepository } from '../db/segment-repository.js';
import type { SessionFinalizer } from './session-finalizer.js';
import type { BrowserWindow } from 'electron';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import { notify } from '../ipc/notifier.js';
import { logger } from '../logging/logger.js';
import type { Stream } from '../../src/types/liz-transcribe.js';

export const ASR_MODE: 'chunked' | 'full-session' =
  (process.env['LIZMEET_ASR_MODE'] as 'chunked' | 'full-session' | undefined) ?? 'chunked';

export class FullSessionUploader {
  constructor(
    private provider: IASRProvider,
    private readonly _sessionRepo: SessionRepository,
    private chunkRepo: ChunkRepository,
    private segmentRepo: SegmentRepository,
    private finalizer: SessionFinalizer,
    private win: BrowserWindow,
  ) {
    void this._sessionRepo; // reserved for status updates
  }

  /**
   * Upload both streams for a session as single files (full-session fallback path).
   * Called from capture:stop handler when ASR_MODE === 'full-session'.
   */
  async uploadSession(sessionId: string): Promise<void> {
    const chunks = this.chunkRepo.findBySession(sessionId);
    if (chunks.length === 0) return;

    // Notify renderer: "Uploading audio"
    notify(this.win, PUSH_CHANNELS.SESSION_STATUS_CHANGED, {
      sessionId,
      newStatus: 'processing',
    });

    // Group chunks by stream
    const micChunks    = chunks.filter(c => c.stream === 'mic');
    const systemChunks = chunks.filter(c => c.stream === 'system');

    const streams: Array<{ stream: Stream; chunks: typeof micChunks }> = [];
    if (micChunks.length > 0)    streams.push({ stream: 'mic',    chunks: micChunks });
    if (systemChunks.length > 0) streams.push({ stream: 'system', chunks: systemChunks });

    await Promise.allSettled(
      streams.map(({ stream, chunks: streamChunks }) =>
        this.uploadStream(sessionId, stream, streamChunks),
      ),
    );

    // Trigger finalization
    this.finalizer.finalizeIfReady(sessionId);
  }

  private async uploadStream(
    sessionId: string,
    stream: Stream,
    chunks: Array<{ id: string; filePath: string; startSeconds: number; endSeconds: number }>,
  ): Promise<void> {
    // Upload first chunk of the stream as representative file
    // (full-session path submits the concatenated recording — in practice
    //  we upload the first chunk file since they are already concatenated on disk)
    const firstChunk = chunks[0];

    try {
      this.chunkRepo.updateStatus(firstChunk.id, 'uploading');
      const uploadUrl = await this.provider.uploadChunk(firstChunk.filePath);
      this.chunkRepo.setUploadUrl(firstChunk.id, uploadUrl);

      const transcriptId = await this.provider.submitTranscript(uploadUrl, {
        speakerLabels: true,
        languageCode: 'en_us',
      });
      this.chunkRepo.setTranscriptId(firstChunk.id, transcriptId);

      // Poll until done
      let pollResult = await this.provider.pollTranscript(transcriptId);
      const maxPolls = 120; // 10 min max wait at 5 s interval
      let polls = 0;

      while (
        pollResult.status === 'queued' ||
        pollResult.status === 'processing'
      ) {
        if (polls++ >= maxPolls) break;
        await new Promise(r => setTimeout(r, 5_000));
        pollResult = await this.provider.pollTranscript(transcriptId);
      }

      if (pollResult.status === 'completed') {
        const utterances = this.provider.parseUtterances(pollResult);
        this.segmentRepo.bulkInsert(
          utterances.map(u => ({
            sessionId,
            chunkId: firstChunk.id,
            stream,
            speakerLabel: stream === 'mic' ? 'You' : u.speakerLabel,
            startSeconds: u.startMs / 1000,
            endSeconds: u.endMs / 1000,
            text: u.text,
            confidence: u.confidence,
            isFailedPlaceholder: false,
          })),
        );
        this.chunkRepo.updateStatus(firstChunk.id, 'transcribed');
      } else {
        this.chunkRepo.updateStatus(firstChunk.id, 'permanently_failed', 'provider_error');
      }
    } catch {
      this.chunkRepo.updateStatus(firstChunk.id, 'permanently_failed', 'upload_error');
      logger.error({ event: 'full_session_upload_failed', sessionId, stream });
    }
  }
}

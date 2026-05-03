// electron/asr/transcript-assembler.ts
// Assembles per-chunk transcripts into session segments.
//
// v1 design: segments are written per-chunk by ChunkProcessor.handleTranscribed
// during polling. At session finalization, assemble() only inserts failure
// placeholders for permanently_failed chunks. Cross-chunk speaker stitching
// (stitchStreamLabels) is deferred to a future release once utterance data is
// cached in the DB alongside segments.

import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SegmentRepository } from '../db/segment-repository.js';
import type { Chunk } from '../../src/types/liz-transcribe.js';
import { logger } from '../logging/logger.js';

/** Format seconds as HH:MM:SS */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class TranscriptAssembler {
  constructor(
    private chunkRepo: ChunkRepository,
    private segmentRepo: SegmentRepository,
  ) {}

  /**
   * Finalize transcript for a session.
   * Segments for transcribed chunks are already in the DB (written by
   * ChunkProcessor.handleTranscribed during polling). This method inserts
   * failure placeholder segments for permanently_failed chunks only.
   */
  assemble(sessionId: string): void {
    const allChunks = this.chunkRepo.findBySession(sessionId);

    const failed = allChunks.filter(c => c.status === 'permanently_failed');
    if (failed.length > 0) {
      this.insertFailurePlaceholders(sessionId, failed);
    }

    logger.info({ event: 'transcript_assembled', sessionId });
  }

  insertFailurePlaceholders(sessionId: string, failedChunks: Chunk[]): void {
    const placeholders = failedChunks.map(chunk => ({
      sessionId,
      chunkId: chunk.id,
      stream: chunk.stream,
      speakerLabel: 'System',
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      text: `[transcription failed for ${formatTime(chunk.startSeconds)} – ${formatTime(chunk.endSeconds)}]`,
      confidence: null,
      isFailedPlaceholder: true,
    }));
    this.segmentRepo.bulkInsert(placeholders);
  }
}

// electron/asr/transcript-assembler.ts
// Assembles per-chunk transcripts into session segments.

import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SegmentRepository } from '../db/segment-repository.js';
import type { IASRProvider, RawUtterance } from './provider-interface.js';
import { stitchStreamLabels } from './diarization-merge.js';
import type { Chunk, Stream } from '../../src/types/liz-transcribe.js';
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
    private readonly _provider: IASRProvider,
  ) {
    void this._provider; // reserved for future streaming path
  }

  /**
   * Assemble all transcribed chunks for a session into segment rows.
   * Called by SessionFinalizer after all chunks are in terminal state.
   */
  assemble(sessionId: string): void {
    const allChunks = this.chunkRepo.findBySession(sessionId);

    // Process each stream separately for stitching
    const micChunks  = allChunks.filter(c => c.stream === 'mic');
    const sysChunks  = allChunks.filter(c => c.stream === 'system');

    const micUtterances  = this.extractUtterances(micChunks);
    const sysUtterances  = this.extractUtterances(sysChunks);

    // Insert stitched utterances as segments
    if (micUtterances.flat().length > 0) {
      const stitched = stitchStreamLabels(
        micUtterances.map((utts, i) => ({
          chunkStartMs: micChunks[i].startSeconds * 1000,
          utterances: utts,
        })),
      );
      this.segmentRepo.bulkInsert(
        stitched.map(u => ({
          sessionId,
          chunkId: null,
          stream: 'mic' as Stream,
          speakerLabel: 'You', // FR-TR-7: mic always labeled "You"
          startSeconds: u.startMs / 1000,
          endSeconds:   u.endMs   / 1000,
          text: u.text,
          confidence: u.confidence,
          isFailedPlaceholder: false,
        })),
      );
    }

    if (sysUtterances.flat().length > 0) {
      const stitched = stitchStreamLabels(
        sysUtterances.map((utts, i) => ({
          chunkStartMs: sysChunks[i].startSeconds * 1000,
          utterances: utts,
        })),
      );
      this.segmentRepo.bulkInsert(
        stitched.map(u => ({
          sessionId,
          chunkId: null,
          stream: 'system' as Stream,
          speakerLabel: u.globalLabel,
          startSeconds: u.startMs / 1000,
          endSeconds:   u.endMs   / 1000,
          text: u.text,
          confidence: u.confidence,
          isFailedPlaceholder: false,
        })),
      );
    }

    // Insert failure placeholders for permanently_failed chunks
    const failed = allChunks.filter(c => c.status === 'permanently_failed');
    if (failed.length > 0) {
      this.insertFailurePlaceholders(sessionId, failed);
    }

    logger.info({ event: 'transcript_assembled', sessionId });
  }

  private extractUtterances(chunks: Chunk[]): RawUtterance[][] {
    // Only transcribed chunks have utterance data
    // We need the parsed result — this is called after all polling is done
    // The utterances are not stored in DB; they were parsed during polling.
    // We store them via segments written during pollTranscript.
    // This method is for the stitching path; in production the data
    // is actually assembled in handleTranscribed in ChunkProcessor.
    // Here we return empty arrays as the data is already in DB from polling.
    return chunks.map(() => []);
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

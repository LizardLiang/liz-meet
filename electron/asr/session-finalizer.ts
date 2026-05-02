// electron/asr/session-finalizer.ts
// Determines and applies the final session status after all chunks are processed.

import type { BrowserWindow } from 'electron';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { SegmentRepository } from '../db/segment-repository.js';
import type { SettingsRepository } from '../db/settings-repository.js';
import type { TranscriptAssembler } from './transcript-assembler.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import { notify } from '../ipc/notifier.js';
import type { SessionStatus } from '../../src/types/liz-transcribe.js';
import { logger } from '../logging/logger.js';
import { app } from 'electron';

export class SessionFinalizer {
  constructor(
    private chunkRepo: ChunkRepository,
    private sessionRepo: SessionRepository,
    private readonly _segmentRepo: SegmentRepository,
    private settingsRepo: SettingsRepository,
    private assembler: TranscriptAssembler,
    private win: BrowserWindow,
  ) {
    void this._segmentRepo; // reserved for future assembly
  }

  /**
   * Called after each chunk status change.
   * If the session is in a terminal-ready state, finalize it.
   */
  finalizeIfReady(sessionId: string): void {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return;

    // Don't finalize while still capturing
    if (session.status === 'recording' || session.status === 'paused') return;

    const chunks = this.chunkRepo.findBySession(sessionId);
    if (chunks.length === 0) return;

    const counts = {
      pending: 0,
      uploading: 0,
      polling: 0,
      transcribed: 0,
      failed: 0,
      permanently_failed: 0,
    };

    for (const c of chunks) {
      counts[c.status as keyof typeof counts] = (counts[c.status as keyof typeof counts] ?? 0) + 1;
    }

    const inFlight =
      counts.pending + counts.uploading + counts.polling + counts.failed;
    if (inFlight > 0) return; // still working

    // All chunks are in terminal state
    let nextStatus: SessionStatus;
    if (counts.transcribed > 0 && counts.permanently_failed === 0) {
      nextStatus = 'completed';
    } else if (counts.transcribed > 0 && counts.permanently_failed > 0) {
      nextStatus = 'completed_with_failures';
    } else {
      nextStatus = 'failed';
    }

    // 1. Run transcript assembly
    if (nextStatus !== 'failed') {
      try {
        this.assembler.assemble(sessionId);
      } catch (err) {
        logger.error({ event: 'assembly_failed', sessionId });
      }
    }

    // 2. Apply audio retention
    this.applyAudioRetention(sessionId, nextStatus);

    // 3. Update DB and notify renderer (L4)
    this.sessionRepo.updateStatus(sessionId, nextStatus);
    notify(this.win, PUSH_CHANNELS.SESSION_STATUS_CHANGED, {
      sessionId,
      newStatus: nextStatus,
    });

    logger.info({ event: 'session_finalized', sessionId, status: nextStatus });
  }

  private applyAudioRetention(sessionId: string, status: SessionStatus): void {
    const keepRawAudio = this.settingsRepo.get<boolean>('keep_raw_audio', false);

    if (status === 'failed') {
      // Force retain on failure — user may want to retry
      logger.info({ event: 'audio_retained_force', sessionId, reason: 'failed' });
      return;
    }

    if (status === 'completed_with_failures') {
      // Keep audio so user can retry failed segments
      logger.info({ event: 'audio_retained', sessionId, reason: 'completed_with_failures' });
      return;
    }

    if (!keepRawAudio && status === 'completed') {
      const recordingsDir = path.join(app.getPath('userData'), 'recordings', sessionId);
      if (existsSync(recordingsDir)) {
        try {
          rmSync(recordingsDir, { recursive: true });
          this.sessionRepo.updateRawAudioPath(sessionId, null);
          logger.info({ event: 'audio_deleted', sessionId });
        } catch {
          logger.warn({ event: 'audio_delete_failed', sessionId });
        }
      }
    }
  }
}

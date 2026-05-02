// electron/capture/recovery.ts
// Orphaned session recovery on app launch (§4.2.6).

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SessionRepository } from '../db/session-repository.js';
import type { ChunkRepository } from '../db/chunk-repository.js';
import { logger } from '../logging/logger.js';

const STALE_SESSION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface RecoveryCandidate {
  sessionId: string;
  title: string;
  startedAt: string;
  chunkCount: number;
}

/**
 * Detect orphaned sessions from a previous crash.
 * - Sessions older than 24 h with no transcribed chunks → auto-finalize to 'failed'
 * - Non-stale candidates → return for recovery modal
 */
export function detectOrphanedSessions(
  sessionRepo: SessionRepository,
  chunkRepo: ChunkRepository,
): RecoveryCandidate[] {
  const candidates = sessionRepo.findAll({ status: ['recording', 'paused'] });
  const recoverable: RecoveryCandidate[] = [];
  const now = Date.now();

  for (const session of candidates) {
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : 0;
    const isStale = now - startedAt > STALE_SESSION_THRESHOLD_MS;
    const chunks = chunkRepo.findBySession(session.id);
    const hasTranscribed = chunks.some(c => c.status === 'transcribed');

    if (isStale && !hasTranscribed) {
      // Auto-finalize to failed
      sessionRepo.updateStatus(session.id, 'failed');
      logger.info({ event: 'stale_session_finalized', sessionId: session.id });
      continue;
    }

    // Scan recordings directory for orphaned WAV files
    reconcileOrphanedFiles(session.id, chunkRepo);

    recoverable.push({
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt ?? session.createdAt,
      chunkCount: chunks.length,
    });
  }

  return recoverable;
}

/**
 * For a session directory, check:
 * - WAV files with no matching chunks row → insert pending chunk
 * - Chunk rows with missing file → mark permanently_failed
 */
function reconcileOrphanedFiles(
  sessionId: string,
  chunkRepo: ChunkRepository,
): void {
  const recordingsDir = path.join(app.getPath('userData'), 'recordings', sessionId);
  if (!existsSync(recordingsDir)) return;

  const existingChunks = chunkRepo.findBySession(sessionId);
  const chunksByPath = new Map(existingChunks.map(c => [c.filePath, c]));

  for (const stream of ['mic', 'system'] as const) {
    const streamDir = path.join(recordingsDir, stream);
    if (!existsSync(streamDir)) continue;

    let files: string[];
    try {
      files = readdirSync(streamDir).filter(f => /\.(wav|webm)$/.test(f)).sort();
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(streamDir, file);
      if (!chunksByPath.has(filePath)) {
        // Orphaned file — insert a pending chunk
        const seq = parseInt(file.replace(/\.\w+$/, ''), 10);
        chunkRepo.create({
          sessionId,
          stream,
          seq: isNaN(seq) ? 9999 : seq,
          filePath,
          startSeconds: 0,
          endSeconds: 0,
        });
        logger.info({ event: 'orphaned_file_recovered', sessionId, filePath });
      }
    }
  }

  // Check for chunk rows with missing files
  const allChunks = chunkRepo.findBySession(sessionId);
  for (const chunk of allChunks) {
    if (!existsSync(chunk.filePath)) {
      chunkRepo.updateStatus(chunk.id, 'permanently_failed', 'file_missing');
      logger.warn({ event: 'chunk_file_missing', chunkId: chunk.id });
    }
  }
}

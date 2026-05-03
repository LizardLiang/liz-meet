// electron/capture/loopback-recorder.ts
// Main-process handler for renderer-sent loopback chunks.
// The renderer uses electron-audio-loopback + MediaRecorder and ships
// binary chunks here via IPC (capture:loopback-chunk).

import { writeFileSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ChunkRepository } from '../db/chunk-repository.js';
import { logger } from '../logging/logger.js';

const MAX_LOOPBACK_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB hard cap §4.2.4

export class LoopbackRecorder {
  private active = false;

  constructor(private chunkRepo: ChunkRepository) {}

  start(): void {
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Handle an incoming loopback chunk from the renderer.
   * Returns { ok: false, error: { code: 'chunk_too_large' } } if the buffer
   * exceeds MAX_LOOPBACK_CHUNK_BYTES (security: prevents renderer-compromise
   * from shipping unbounded ArrayBuffers to main).
   */
  handleChunk(payload: {
    sessionId: string;
    seq: number;
    mimeType: string;
    buffer: ArrayBuffer;
    startSeconds: number;
    endSeconds: number;
  }): { ok: boolean; error?: { code: string } } {
    if (!this.active) return { ok: false, error: { code: 'not_recording' } };

    // Validate sessionId is a UUID to prevent path traversal (M-01)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.sessionId)) {
      logger.warn({ event: 'loopback_invalid_session_id', seq: payload.seq });
      return { ok: false, error: { code: 'invalid_session_id' } };
    }

    if (payload.buffer.byteLength > MAX_LOOPBACK_CHUNK_BYTES) {
      logger.warn({ event: 'loopback_chunk_oversize', seq: payload.seq });
      return { ok: false, error: { code: 'chunk_too_large' } };
    }

    const ext = payload.mimeType.includes('webm') ? 'webm' : 'wav';
    const dir = path.join(
      app.getPath('userData'),
      'recordings',
      payload.sessionId,
      'system',
    );
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const fileName = `${String(payload.seq).padStart(6, '0')}.${ext}`;
    const filePath = path.join(dir, fileName);

    const buffer = Buffer.from(payload.buffer);
    writeFileSync(filePath, buffer);

    // fsync before DB insert (DB-First Write L3)
    // Windows does not support fsync on a read-only fd
    if (process.platform !== 'win32') {
      const fd = openSync(filePath, 'r');
      fsyncSync(fd);
      closeSync(fd);
    }

    // Insert chunks row
    this.chunkRepo.create({
      sessionId: payload.sessionId,
      stream: 'system',
      seq: payload.seq,
      filePath,
      startSeconds: payload.startSeconds,
      endSeconds: payload.endSeconds,
    });

    return { ok: true };
  }
}

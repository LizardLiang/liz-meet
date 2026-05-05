// electron/capture/loopback-recorder.ts
// Native WASAPI loopback capture for system audio recording.
// Uses the @liz-meet/loopback-capture C++ N-API addon to read the render
// endpoint mix directly — no renderer involvement, no WebRTC echo-cancellation,
// no Bluetooth A2DP → HFP profile flip.

import { createRequire } from 'node:module';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { ChunkRepository } from '../db/chunk-repository.js';
import { notify } from '../ipc/notifier.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import { logger } from '../logging/logger.js';

type LoopbackEvent =
  | { type: 'vu';    rmsDb: number }
  | { type: 'chunk'; path: string; seq: number; startSeconds: number; endSeconds: number }
  | { type: 'error'; message: string };

interface NativeLoopback {
  start(opts: { sessionDir?: string; chunkSeconds?: number; vuIntervalMs?: number },
        cb: (e: LoopbackEvent) => void): void;
  stop(): void;
  isRunning(): boolean;
}

// Lazy-load so the module fails gracefully on non-Windows at import time
let _native: NativeLoopback | null = null;
function getNative(): NativeLoopback | null {
  if (process.platform !== 'win32') return null;
  if (!_native) {
    try {
      _native = createRequire(import.meta.url)('@liz-meet/loopback-capture') as NativeLoopback;
    } catch (err) {
      logger.error({ event: 'loopback_addon_load_failed', err: String(err) });
    }
  }
  return _native;
}

export class LoopbackRecorder {
  private active = false;

  constructor(
    private chunkRepo: ChunkRepository,
    private win: BrowserWindow,
  ) {}

  start(sessionId: string, chunkSeconds: number): void {
    if (this.active) return;
    const native = getNative();
    if (!native) {
      logger.warn({ event: 'loopback_unsupported_platform' });
      return;
    }

    const sessionDir = path.join(
      app.getPath('userData'),
      'recordings',
      sessionId,
      'system',
    );

    logger.info({ event: 'loopback_native_start_begin', sessionDir });
    native.start({ sessionDir, chunkSeconds, vuIntervalMs: 50 }, (e) => {
      if (e.type === 'vu') {
        notify(this.win, PUSH_CHANNELS.CAPTURE_VU_UPDATE, {
          stream: 'system',
          rmsDb: e.rmsDb,
        });
      } else if (e.type === 'chunk') {
        this.chunkRepo.create({
          sessionId,
          stream: 'system',
          seq: e.seq,
          filePath: e.path,
          startSeconds: e.startSeconds,
          endSeconds: e.endSeconds,
        });
        logger.info({ event: 'loopback_chunk_written', seq: e.seq });
      } else {
        logger.error({ event: 'loopback_native_error', message: e.message });
      }
    });

    this.active = true;
    logger.info({ event: 'loopback_started', sessionId });
    logger.info({ event: 'loopback_native_start_done' });
  }

  stop(): void {
    if (!this.active) return;
    getNative()?.stop();
    this.active = false;
    logger.info({ event: 'loopback_stopped' });
  }

  isActive(): boolean {
    return this.active;
  }
}

// ---- Preview mode (pre-flight VU only, no WAV chunks) ----

let previewActive = false;

export function startLoopbackPreview(win: BrowserWindow): void {
  if (previewActive) return;
  const native = getNative();
  if (!native) return;
  native.start({ vuIntervalMs: 50 }, (e) => {
    if (e.type === 'vu') {
      notify(win, PUSH_CHANNELS.CAPTURE_VU_UPDATE, { stream: 'system', rmsDb: e.rmsDb });
    }
  });
  previewActive = true;
}

export function stopLoopbackPreview(): void {
  if (!previewActive) return;
  getNative()?.stop();
  previewActive = false;
}

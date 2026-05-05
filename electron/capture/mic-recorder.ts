// electron/capture/mic-recorder.ts
// Mic capture using the @liz-meet/loopback-capture WASAPI addon (eCapture endpoint).

import { createRequire } from 'node:module';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { ChunkRepository } from '../db/chunk-repository.js';
import { notify } from '../ipc/notifier.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import { logger } from '../logging/logger.js';

type MicEvent =
  | { type: 'vu';    rmsDb: number }
  | { type: 'chunk'; path: string; seq: number; startSeconds: number; endSeconds: number }
  | { type: 'error'; message: string };

interface NativeAddon {
  listInputDevices(): Array<{ id: string; name: string; isDefault: boolean }>;
  startMic(
    opts: { sessionDir?: string; deviceId?: string; chunkSeconds?: number; vuIntervalMs?: number },
    cb: (e: MicEvent) => void,
  ): void;
  stopMic(): void;
  isMicRunning(): boolean;
  // loopback API is also on this object; not typed here
}

let _native: NativeAddon | null = null;
function getNative(): NativeAddon | null {
  if (process.platform !== 'win32') return null;
  if (!_native) {
    try {
      _native = createRequire(import.meta.url)('@liz-meet/loopback-capture') as NativeAddon;
    } catch (err) {
      logger.error({ event: 'mic_addon_load_failed', err: String(err) });
    }
  }
  return _native;
}

export class MicRecorder {
  private active = false;

  constructor(
    private win: BrowserWindow,
    private chunkRepo: ChunkRepository,
  ) {}

  start(sessionId: string, deviceId: string | null, chunkDurationSeconds: number): void {
    if (this.active) return;
    const native = getNative();
    if (!native) {
      logger.warn({ event: 'mic_unsupported_platform' });
      return;
    }

    const sessionDir = path.join(
      app.getPath('userData'),
      'recordings',
      sessionId,
      'mic',
    );

    native.startMic(
      {
        sessionDir,
        deviceId: deviceId ?? undefined,
        chunkSeconds: chunkDurationSeconds,
        vuIntervalMs: 50,
      },
      (e) => {
        if (e.type === 'vu') {
          notify(this.win, PUSH_CHANNELS.CAPTURE_VU_UPDATE, {
            stream: 'mic',
            rmsDb: e.rmsDb,
          });
        } else if (e.type === 'chunk') {
          try {
            this.chunkRepo.create({
              sessionId,
              stream: 'mic',
              seq: e.seq,
              filePath: e.path,
              startSeconds: e.startSeconds,
              endSeconds: e.endSeconds,
            });
            logger.info({ event: 'mic_chunk_written', seq: e.seq, path: e.path });
          } catch (err) {
            logger.error({ event: 'mic_chunk_insert_failed', seq: e.seq, err: String(err) });
          }
        } else {
          logger.error({ event: 'mic_native_error', message: e.message });
          notify(this.win, PUSH_CHANNELS.CAPTURE_DEVICE_EVENT, {
            stream: 'mic',
            event: 'removed',
          });
        }
      },
    );

    this.active = true;
    logger.info({ event: 'mic_started', sessionId });
  }

  pause(): void {
    // WASAPI capture is continuous; the session-level flush is not needed here
  }

  stop(): void {
    if (!this.active) return;
    getNative()?.stopMic();
    this.active = false;
    logger.info({ event: 'mic_stopped' });
  }

  isActive(): boolean {
    return this.active;
  }

  static listDevices(): Array<{ id: string; name: string; isDefault: boolean }> {
    try {
      const native = createRequire(import.meta.url)('@liz-meet/loopback-capture') as NativeAddon;
      return native.listInputDevices();
    } catch {
      return [];
    }
  }
}

// ---- Preview mode (pre-flight VU only, no WAV chunks) ----

let previewActive = false;
let previewDeviceId: string | null = null;

export function startMicPreview(win: BrowserWindow, deviceId: string | null): void {
  if (previewActive) {
    if (deviceId === previewDeviceId) return;
    stopMicPreview(); // restart on different device
  }
  const native = getNative();
  if (!native) return;
  native.startMic({ deviceId: deviceId ?? undefined, vuIntervalMs: 50 }, (e) => {
    if (e.type === 'vu') {
      notify(win, PUSH_CHANNELS.CAPTURE_VU_UPDATE, { stream: 'mic', rmsDb: e.rmsDb });
    }
  });
  previewActive = true;
  previewDeviceId = deviceId;
}

export function stopMicPreview(): void {
  if (!previewActive) return;
  getNative()?.stopMic();
  previewActive = false;
  previewDeviceId = null;
}

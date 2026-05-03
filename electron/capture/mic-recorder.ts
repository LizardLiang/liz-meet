// electron/capture/mic-recorder.ts
// Mic capture using naudiodon2 (main-process native, locked decision L1).

import type { BrowserWindow } from 'electron';
import type { ChunkRepository } from '../db/chunk-repository.js';
import { ChunkAccumulator } from './chunk-accumulator.js';
import { notify } from '../ipc/notifier.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import { logger } from '../logging/logger.js';

type NaudiodonDevice = { id: number; name: string; maxInputChannels: number };
interface NaudiodonAudioStream extends NodeJS.EventEmitter {
  start(): void;
  quit(): void;
}
interface NaudiodonModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AudioIO: new (opts: any) => NaudiodonAudioStream;
  SampleFormat16Bit: number;
  getDevices(): NaudiodonDevice[];
}
// naudiodon2 is a native addon — use createRequire for ESM/CJS compatibility
import { createRequire } from 'node:module';
const naudiodon = createRequire(import.meta.url)('naudiodon2') as NaudiodonModule;

export class MicRecorder {
  private audioIn: NaudiodonAudioStream | null = null;
  private accumulator: ChunkAccumulator | null = null;
  private active = false;

  constructor(
    private win: BrowserWindow,
    private chunkRepo: ChunkRepository,
  ) {}

  start(
    sessionId: string,
    deviceId: number,
    chunkDurationSeconds: number,
  ): void {
    if (this.active) return;

    this.accumulator = new ChunkAccumulator(
      sessionId,
      'mic',
      chunkDurationSeconds,
      this.chunkRepo,
      this.win,
    );

    try {
      this.audioIn = new naudiodon.AudioIO({
        inOptions: {
          deviceId: deviceId ?? -1,
          sampleRate: 16_000,
          channelCount: 1,
          sampleFormat: naudiodon.SampleFormat16Bit,
          framesPerBuffer: 1_600, // 100 ms frames
          closeOnError: false,
        },
      });

      this.audioIn.on('data', (buffer: Buffer) => {
        this.accumulator?.push(buffer);
      });

      this.audioIn.on('error', (err: Error) => {
        logger.error({ event: 'mic_error', code: 'capture_failed' });
        notify(this.win, PUSH_CHANNELS.CAPTURE_DEVICE_EVENT, {
          stream: 'mic',
          event: 'removed',
          errorCode: 0,
        });
        void err;
      });

      this.audioIn.start();
      this.active = true;
      logger.info({ event: 'mic_started', sessionId });
    } catch (err) {
      logger.error({ event: 'mic_start_failed', code: 'capture_failed' });
      throw err;
    }
  }

  pause(): void {
    this.accumulator?.flush();
  }

  stop(): void {
    if (!this.active) return;
    this.accumulator?.flush();
    this.audioIn?.quit();
    this.audioIn = null;
    this.active = false;
    logger.info({ event: 'mic_stopped' });
  }

  isActive(): boolean {
    return this.active;
  }

  getAccumulator(): ChunkAccumulator | null {
    return this.accumulator;
  }

  static getDevices(): Array<{ id: number; name: string; maxInputChannels: number }> {
    try {
      return naudiodon.getDevices();
    } catch {
      return [];
    }
  }
}

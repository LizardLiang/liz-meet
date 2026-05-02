// electron/capture/chunk-accumulator.ts
// PCM accumulation + WAV write + DB insert (DB-First Write — locked decision L3).

import { existsSync, mkdirSync, writeFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ChunkRepository } from '../db/chunk-repository.js';
import type { BrowserWindow } from 'electron';
import { computeRmsDb } from './vu-meter.js';
import { notify } from '../ipc/notifier.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import type { Stream } from '../../src/types/liz-transcribe.js';

const SAMPLE_RATE = 16_000;    // Hz
const CHANNELS_COUNT = 1;      // mono
const BIT_DEPTH = 16;          // bits per sample
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;
const VU_WINDOW_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 0.1; // 100 ms window

/**
 * Write a WAV file from PCM buffer.
 * Format: RIFF / WAVE / fmt (PCM) / data
 */
function writeWav(filePath: string, pcmData: Buffer, sampleRate: number): void {
  const numChannels = CHANNELS_COUNT;
  const bitsPerSample = BIT_DEPTH;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const header = Buffer.alloc(headerSize);
  let offset = 0;

  // RIFF header
  header.write('RIFF', offset);           offset += 4;
  header.writeUInt32LE(totalSize - 8, offset); offset += 4;
  header.write('WAVE', offset);           offset += 4;
  // fmt chunk
  header.write('fmt ', offset);           offset += 4;
  header.writeUInt32LE(16, offset);       offset += 4; // chunk size
  header.writeUInt16LE(1, offset);        offset += 2; // PCM
  header.writeUInt16LE(numChannels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset);  offset += 4;
  header.writeUInt32LE(byteRate, offset);    offset += 4;
  header.writeUInt16LE(blockAlign, offset);  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;
  // data chunk
  header.write('data', offset);           offset += 4;
  header.writeUInt32LE(dataSize, offset);

  const wavBuffer = Buffer.concat([header, pcmData]);
  writeFileSync(filePath, wavBuffer);

  // fsync before DB insert (DB-First Write L3)
  const fd = openSync(filePath, 'r');
  fsyncSync(fd);
  closeSync(fd);
}

export class ChunkAccumulator {
  private buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private seq = 0;
  private chunkStartSeconds = 0;
  private sessionStartTime = Date.now();
  private vuAccumulator: Buffer[] = [];
  private vuAccumulatedBytes = 0;
  private lastChunkWriteAt = Date.now();

  constructor(
    private sessionId: string,
    private stream: Stream,
    private chunkDurationSeconds: number,
    private chunkRepo: ChunkRepository,
    private win: BrowserWindow,
  ) {}

  /** Feed raw PCM data into the accumulator. */
  push(pcm: Buffer): void {
    this.buffers.push(pcm);
    this.bufferedBytes += pcm.length;
    this.vuAccumulator.push(pcm);
    this.vuAccumulatedBytes += pcm.length;

    // Emit VU update every 100 ms
    if (this.vuAccumulatedBytes >= VU_WINDOW_BYTES) {
      const vuBuf = Buffer.concat(this.vuAccumulator);
      const rmsDb = computeRmsDb(vuBuf);
      notify(this.win, PUSH_CHANNELS.CAPTURE_VU_UPDATE, {
        stream: this.stream,
        rmsDb,
      });
      this.vuAccumulator = [];
      this.vuAccumulatedBytes = 0;
    }

    // Check if we've accumulated enough for a chunk
    const targetBytes =
      this.chunkDurationSeconds * SAMPLE_RATE * BYTES_PER_SAMPLE;
    if (this.bufferedBytes >= targetBytes) {
      this.flush();
    }
  }

  /** Flush the current buffer as a partial/complete chunk. */
  flush(): void {
    if (this.bufferedBytes === 0) return;

    const pcmData = Buffer.concat(this.buffers);
    const actualSeconds = pcmData.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    const startSeconds = this.chunkStartSeconds;
    const endSeconds = startSeconds + actualSeconds;
    const seqNum = this.seq++;

    const dir = path.join(
      app.getPath('userData'),
      'recordings',
      this.sessionId,
      this.stream,
    );
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const fileName = `${String(seqNum).padStart(6, '0')}.wav`;
    const filePath = path.join(dir, fileName);

    // Write WAV (includes fsync)
    writeWav(filePath, pcmData, SAMPLE_RATE);
    this.lastChunkWriteAt = Date.now();

    // DB INSERT (after fsync — DB-First Write)
    this.chunkRepo.create({
      sessionId: this.sessionId,
      stream: this.stream,
      seq: seqNum,
      filePath,
      startSeconds,
      endSeconds,
    });

    // Reset accumulator
    this.buffers = [];
    this.bufferedBytes = 0;
    this.chunkStartSeconds = endSeconds;
  }

  getLastChunkWriteAt(): number {
    return this.lastChunkWriteAt;
  }

  getElapsedSeconds(): number {
    return (Date.now() - this.sessionStartTime) / 1000;
  }
}

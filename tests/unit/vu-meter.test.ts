// tests/unit/vu-meter.test.ts
// VU meter RMS computation

import { describe, it, expect } from 'vitest';
import { computeRmsDb } from '../../electron/capture/vu-meter.js';

describe('computeRmsDb', () => {
  it('UNIT-008: silent PCM produces RMS near 0 (very negative dB)', () => {
    const buf = Buffer.alloc(640, 0); // 320 samples of silence
    const rms = computeRmsDb(buf);
    expect(rms).toBeLessThanOrEqual(-60);
  });

  it('maximum signal (full scale) produces 0 dBFS', () => {
    // Full-scale sine wave: alternating +32767 / -32768
    const buf = Buffer.alloc(640);
    for (let i = 0; i < buf.length; i += 2) {
      buf.writeInt16LE(i % 4 === 0 ? 32767 : -32768, i);
    }
    const rms = computeRmsDb(buf);
    // Full-scale should be near 0 dBFS (within 1 dB)
    expect(rms).toBeGreaterThan(-1);
    expect(rms).toBeLessThanOrEqual(0.1);
  });

  it('returns -100 for empty buffer', () => {
    const rms = computeRmsDb(Buffer.alloc(0));
    expect(rms).toBe(-100);
  });

  it('returns -100 for 1-byte buffer', () => {
    const rms = computeRmsDb(Buffer.alloc(1));
    expect(rms).toBe(-100);
  });
});

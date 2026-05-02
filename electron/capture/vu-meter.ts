// electron/capture/vu-meter.ts
// RMS level computation for VU meter emission.

/**
 * Compute RMS (Root Mean Square) in dBFS from a 16-bit PCM buffer.
 * Returns a value ≤ 0 dBFS. Silent audio returns approximately -100 dBFS.
 */
export function computeRmsDb(buffer: Buffer): number {
  if (buffer.length < 2) return -100;

  const samples = buffer.length / 2; // 16-bit = 2 bytes per sample
  let sumSquares = 0;

  for (let i = 0; i < buffer.length - 1; i += 2) {
    // Read signed 16-bit little-endian sample
    const sample = buffer.readInt16LE(i) / 32768;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / samples);
  if (rms < 1e-7) return -100; // silence floor

  return 20 * Math.log10(rms);
}

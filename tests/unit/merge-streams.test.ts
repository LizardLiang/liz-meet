// tests/unit/merge-streams.test.ts
// mergeStreams unit tests: UNIT-042–046
// FR-TR-7: mic relabeled "You", clock-drift offset, stream field, sorted timeline, empty edge cases.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mergeStreams } from '../../electron/asr/diarization-merge.js';
import type { RawUtterance } from '../../electron/asr/provider-interface.js';

function utt(
  speakerLabel: string,
  startMs: number,
  endMs: number,
  text = 'test',
  confidence: number | null = null,
): RawUtterance {
  return { speakerLabel, startMs, endMs, text, confidence };
}

const SESSION_ID = 'sess-001';
// Common wall-clock start times: system starts 500 ms after mic → offsetMs = +500
const MIC_START = 1_000_000;
const SYS_START = 1_000_500; // 500 ms drift

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mergeStreams — UNIT-042–046', () => {
  // UNIT-042: Mic utterances relabeled with "You" label
  it('UNIT-042: all mic utterances have speakerLabel "You" regardless of original label', () => {
    const mic = [
      utt('A', 0, 3_000, 'Hello'),
      utt('B', 3_000, 6_000, 'World'),
    ];
    const system: RawUtterance[] = [];

    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(2);
    for (const seg of result) {
      expect(seg.speakerLabel).toBe('You');
    }
  });

  // UNIT-042b: System utterances keep their original labels
  it('UNIT-042b: system utterances preserve their original speaker labels', () => {
    const mic: RawUtterance[] = [];
    const system = [
      utt('G0', 0, 3_000, 'Remote speaker 1'),
      utt('G1', 3_000, 6_000, 'Remote speaker 2'),
    ];

    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(2);
    expect(result[0].speakerLabel).toBe('G0');
    expect(result[1].speakerLabel).toBe('G1');
  });

  // UNIT-043: Clock-drift offset applied correctly to system utterances
  it('UNIT-043: positive drift — system times shifted forward by (systemStart - micStart)', () => {
    // system started 500 ms after mic → system utterance at t=1000 ms aligns to t=1500 ms globally
    const mic: RawUtterance[] = [];
    const system = [utt('G0', 1_000, 2_000)];

    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, SYS_START);

    expect(result).toHaveLength(1);
    // offsetMs = SYS_START - MIC_START = 500 ms
    // startSeconds = (1000 + 500) / 1000 = 1.5
    expect(result[0].startSeconds).toBeCloseTo(1.5);
    expect(result[0].endSeconds).toBeCloseTo(2.5);
  });

  it('UNIT-043b: negative drift — system times shifted backward when system started before mic', () => {
    // system started 300 ms before mic → offsetMs = -300
    const mic: RawUtterance[] = [];
    const system = [utt('G0', 1_000, 2_000)];

    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START - 300);

    expect(result).toHaveLength(1);
    // startSeconds = (1000 - 300) / 1000 = 0.7
    expect(result[0].startSeconds).toBeCloseTo(0.7);
    expect(result[0].endSeconds).toBeCloseTo(1.7);
  });

  it('UNIT-043c: zero drift — system times unchanged when both streams started at same time', () => {
    const system = [utt('G0', 2_000, 4_000)];

    const result = mergeStreams([], system, SESSION_ID, MIC_START, MIC_START);

    expect(result[0].startSeconds).toBeCloseTo(2.0);
    expect(result[0].endSeconds).toBeCloseTo(4.0);
  });

  it('UNIT-043d: mic utterances are NOT affected by drift offset', () => {
    const mic = [utt('A', 0, 3_000)];

    const result = mergeStreams(mic, [], SESSION_ID, MIC_START, SYS_START);

    // Mic times must NOT be shifted — only system is shifted
    expect(result[0].startSeconds).toBeCloseTo(0.0);
    expect(result[0].endSeconds).toBeCloseTo(3.0);
  });

  // UNIT-044: stream field populated correctly on each segment
  it('UNIT-044: mic segments have stream="mic"', () => {
    const mic = [utt('A', 0, 2_000)];
    const result = mergeStreams(mic, [], SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(1);
    expect(result[0].stream).toBe('mic');
  });

  it('UNIT-044b: system segments have stream="system"', () => {
    const system = [utt('G0', 0, 2_000)];
    const result = mergeStreams([], system, SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(1);
    expect(result[0].stream).toBe('system');
  });

  it('UNIT-044c: mixed results have correct stream tags for each segment', () => {
    const mic = [utt('A', 0, 2_000)];
    const system = [utt('G0', 2_000, 4_000)];
    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    const micSegs = result.filter(s => s.stream === 'mic');
    const sysSegs = result.filter(s => s.stream === 'system');
    expect(micSegs).toHaveLength(1);
    expect(sysSegs).toHaveLength(1);
  });

  // UNIT-045: Sorted timeline output
  it('UNIT-045: output is sorted by startSeconds ascending', () => {
    // Interleaved mic and system with intentional out-of-order positioning
    const mic = [
      utt('A', 4_000, 6_000, 'Third'),
      utt('A', 0, 2_000, 'First'),
    ];
    const system = [
      utt('G0', 6_000, 8_000, 'Fourth'),
      utt('G0', 2_000, 4_000, 'Second'),
    ];

    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(4);
    const times = result.map(s => s.startSeconds);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it('UNIT-045b: sorting is stable when drift causes system segment to precede mic segment', () => {
    // System started 2000 ms before mic. A system utterance at t=3000 (local) → t=1000 (global),
    // which is before the mic utterance at t=2000.
    const micStart = 1_000_000;
    const sysStart = 1_000_000 - 2_000; // system started 2 s earlier
    const mic = [utt('A', 2_000, 4_000)];
    const system = [utt('G0', 3_000, 5_000)]; // shifted: 3000 - 2000 = 1000 ms globally

    const result = mergeStreams(mic, system, SESSION_ID, micStart, sysStart);

    expect(result).toHaveLength(2);
    // After drift correction, system seg starts at (3000 - 2000) = 1000 ms = 1.0 s
    // Mic seg starts at 2000 ms = 2.0 s → system should come first
    expect(result[0].stream).toBe('system');
    expect(result[1].stream).toBe('mic');
    expect(result[0].startSeconds).toBeLessThan(result[1].startSeconds);
  });

  // UNIT-046: Empty stream edge cases
  it('UNIT-046: both streams empty → empty array', () => {
    const result = mergeStreams([], [], SESSION_ID, MIC_START, MIC_START);
    expect(result).toHaveLength(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it('UNIT-046b: mic-only (no system utterances) → only mic segments in output', () => {
    const mic = [utt('A', 0, 5_000), utt('A', 5_000, 10_000)];
    const result = mergeStreams(mic, [], SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(2);
    expect(result.every(s => s.stream === 'mic')).toBe(true);
    expect(result.every(s => s.speakerLabel === 'You')).toBe(true);
  });

  it('UNIT-046c: system-only (no mic utterances) → only system segments in output', () => {
    const system = [utt('G0', 0, 5_000)];
    const result = mergeStreams([], system, SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(1);
    expect(result[0].stream).toBe('system');
    expect(result[0].speakerLabel).toBe('G0');
  });

  // Additional invariants
  it('sessionId is correctly set on all output segments', () => {
    const mic = [utt('A', 0, 1_000)];
    const system = [utt('G0', 1_000, 2_000)];
    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    for (const seg of result) {
      expect(seg.sessionId).toBe(SESSION_ID);
    }
  });

  it('isFailedPlaceholder is always false for merged segments', () => {
    const mic = [utt('A', 0, 2_000)];
    const system = [utt('G0', 2_000, 4_000)];
    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    for (const seg of result) {
      expect(seg.isFailedPlaceholder).toBe(false);
    }
  });

  it('total segment count equals sum of mic + system utterances', () => {
    const mic = [utt('A', 0, 1_000), utt('B', 1_000, 2_000), utt('A', 2_000, 3_000)];
    const system = [utt('G0', 0, 1_500), utt('G1', 1_500, 3_000)];
    const result = mergeStreams(mic, system, SESSION_ID, MIC_START, MIC_START);

    expect(result).toHaveLength(mic.length + system.length);
  });

  it('drift > 200 ms triggers a logger.warn (does not throw)', async () => {
    const { logger } = await import('../../electron/logging/logger.js');
    const warnSpy = vi.mocked(logger.warn);

    // 300 ms drift
    mergeStreams([], [utt('G0', 0, 1_000)], SESSION_ID, MIC_START, MIC_START + 300);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'drift_exceeded' }),
    );
  });

  it('drift <= 200 ms does not trigger logger.warn', async () => {
    const { logger } = await import('../../electron/logging/logger.js');
    const warnSpy = vi.mocked(logger.warn);

    mergeStreams([], [utt('G0', 0, 1_000)], SESSION_ID, MIC_START, MIC_START + 100);

    const driftCalls = warnSpy.mock.calls.filter(
      ([payload]) => (payload as { event?: string }).event === 'drift_exceeded',
    );
    expect(driftCalls).toHaveLength(0);
  });
});

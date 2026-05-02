// tests/unit/diarization-merge.test.ts
// Suite U8: stitchStreamLabels algorithm (UNIT-060–075)

import { describe, it, expect } from 'vitest';
import { stitchStreamLabels } from '../../electron/asr/diarization-merge.js';
import type { RawUtterance } from '../../electron/asr/provider-interface.js';

function utterance(speaker: string, startMs: number, endMs: number, text = 'test'): RawUtterance {
  return { speakerLabel: speaker, startMs, endMs, text, confidence: null };
}

describe('stitchStreamLabels', () => {
  it('UNIT-060: chunk 1 labels get fresh global labels', () => {
    const chunks = [
      { chunkStartMs: 0, utterances: [utterance('A', 0, 5000), utterance('B', 5000, 10000)] },
    ];
    const result = stitchStreamLabels(chunks);
    expect(result).toHaveLength(2);
    const g0 = result[0].globalLabel;
    const g1 = result[1].globalLabel;
    expect(g0).toMatch(/^G\d+$/);
    expect(g1).toMatch(/^G\d+$/);
    expect(g0).not.toBe(g1);
  });

  it('UNIT-061: same-speaker match across boundary (utterance spans boundary window)', () => {
    // Chunk 1: A at 8000-10000 (overlaps past boundary)
    // Chunk 2 starts at 10000: A at 9500-14000 (overlaps before boundary)
    // Both utterances overlap in [8500, 11500] window → should match
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 8_000, 10_000)] },
      { chunkStartMs: 10_000, utterances: [utterance('A', 9_500, 14_000)] },
    ];
    const result = stitchStreamLabels(chunks);
    // Both should map to the same global label
    expect(result[0].globalLabel).toBe(result[1].globalLabel);
  });

  it('UNIT-062: new speaker in chunk 2 gets a fresh global label', () => {
    // Chunk 1: A at 0-9000 (no tail in boundary window)
    // Chunk 2: A starts at 10200 (no overlap with prev A since prev A ends at 9000 < 8500 boundary start)
    //          B starts at 14000 (no overlap at all)
    // Both A and B in chunk 2 are new speakers
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 0, 7000)] },  // ends before boundary window
      { chunkStartMs: 10_000, utterances: [
        utterance('A', 10_200, 14_000),  // no overlap with prev A (A ended at 7000ms)
        utterance('B', 14_000, 18_000),  // new speaker
      ]},
    ];
    const result = stitchStreamLabels(chunks);
    const prevAGlobal = result[0].globalLabel;
    // chunk 2's labels should be different from chunk 1's A (no overlap possible)
    const chunk2Labels = result.slice(1).map(u => u.globalLabel);
    for (const label of chunk2Labels) {
      expect(label).not.toBe(prevAGlobal);
    }
    expect(chunk2Labels[0]).toMatch(/^G\d+$/);
    expect(chunk2Labels[1]).toMatch(/^G\d+$/);
    expect(chunk2Labels[0]).not.toBe(chunk2Labels[1]);
  });

  it('UNIT-063: duration-weighted: long-overlap wins over short-overlap', () => {
    // Chunk 1: A at 8000–10000 (2000ms in window), B at 9500–10000 (500ms in window)
    // Chunk 2 starts at 10000: currX at 8000–11000 overlaps both prevA and prevB
    // The test verifies that longer overlap wins.
    // currX overlaps prevA for ~2000ms, prevB for ~500ms → should match A
    const chunks = [
      { chunkStartMs: 0,      utterances: [
        utterance('A', 8_000, 10_000),  // 2000ms in [8500, 11500] window
        utterance('B', 9_500, 10_000),  // 500ms in window
      ]},
      { chunkStartMs: 10_000, utterances: [
        utterance('X', 8_000, 11_000),  // overlaps A heavily
      ]},
    ];
    const result = stitchStreamLabels(chunks);
    const prevAGlobal = result[0].globalLabel;  // chunk 1's A
    // result[1] is B, result[2] is X
    const chunk2XGlobal = result[2].globalLabel;
    // X has more overlap with A, so it matches A
    expect(chunk2XGlobal).toBe(prevAGlobal);
  });

  it('UNIT-064: overlap < MIN_OVERLAP_MS (100ms) treated as new speaker', () => {
    // Only 50ms overlap
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 9_950, 10_000)] }, // 50ms before boundary
      { chunkStartMs: 10_000, utterances: [utterance('A', 9_975, 10_050)] }, // 25ms overlap with prev
    ];
    const result = stitchStreamLabels(chunks);
    // With only 25ms overlap (< MIN_OVERLAP_MS 100ms), should not match → different global labels
    expect(result[0].globalLabel).not.toBe(result[1].globalLabel);
  });

  it('UNIT-065: low-ratio overlap (< 0.30) treated as new speaker', () => {
    // 200ms overlap on 1200ms shorter side → ratio = 0.167 < 0.30
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 8_800, 10_000)] }, // 1200ms in boundary window
      { chunkStartMs: 10_000, utterances: [utterance('A', 9_800, 11_200)] }, // 200ms overlap with prev
    ];
    const result = stitchStreamLabels(chunks);
    expect(result[0].globalLabel).not.toBe(result[1].globalLabel);
  });

  it('UNIT-066: greedy 1:1 - once matched, prev label cannot be matched again', () => {
    // A and B in chunk 2 both overlap prev A. Higher overlap wins.
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 8_000, 10_000)] }, // 2000ms in window
      { chunkStartMs: 10_000, utterances: [
        utterance('A', 8_000, 11_500),  // 2000ms overlap with prev A
        utterance('B', 9_000, 11_000),  // 1000ms overlap with prev A
      ]},
    ];
    const result = stitchStreamLabels(chunks);
    const prevAGlobal = result[0].globalLabel;
    // Chunk 2: A should match prev A (more overlap), B should get new label
    const chunk2Globals = result.slice(1).map(u => u.globalLabel);
    // One of chunk2's labels should equal prevA, the other should not
    const matchedToPrev = chunk2Globals.filter(g => g === prevAGlobal);
    const unmatched      = chunk2Globals.filter(g => g !== prevAGlobal);
    expect(matchedToPrev.length).toBe(1);
    expect(unmatched.length).toBe(1);
  });

  it('UNIT-067: deterministic - same input produces same output', () => {
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 0, 9000), utterance('B', 9000, 10000)] },
      { chunkStartMs: 10_000, utterances: [utterance('A', 9500, 14000), utterance('B', 14000, 19000)] },
    ];
    const r1 = stitchStreamLabels(chunks).map(u => u.globalLabel);
    const r2 = stitchStreamLabels(chunks).map(u => u.globalLabel);
    expect(r1).toEqual(r2);
  });

  it('UNIT-070: 3-speaker boundary — all three labels from chunk 2 match chunk 1', () => {
    // Non-overlapping speakers in the window: A, B, C each have distinct non-overlapping time slots
    // Chunk boundary at 10000ms. Window: [8500, 11500]
    // A: 8500–9000 in prev, 8700–9200 in curr → only A can match A
    // B: 9000–9500 in prev, 9200–9700 in curr → only B can match B
    // C: 9500–10000 in prev, 9700–10200 in curr → only C can match C
    const chunks = [
      { chunkStartMs: 0,      utterances: [
        utterance('A', 8_500, 9_000),
        utterance('B', 9_000, 9_500),
        utterance('C', 9_500, 10_000),
      ]},
      { chunkStartMs: 10_000, utterances: [
        utterance('A', 8_700, 9_200),
        utterance('B', 9_200, 9_700),
        utterance('C', 9_700, 10_200),
      ]},
    ];
    const result = stitchStreamLabels(chunks);
    const prevByLocal = new Map<string, string>();
    for (const u of result.slice(0, 3)) {
      prevByLocal.set(u.speakerLabel, u.globalLabel);
    }
    const nextByLocal = new Map<string, string>();
    for (const u of result.slice(3, 6)) {
      nextByLocal.set(u.speakerLabel, u.globalLabel);
    }
    // Each speaker's global label should be the same across the boundary
    expect(nextByLocal.get('A')).toBe(prevByLocal.get('A'));
    expect(nextByLocal.get('B')).toBe(prevByLocal.get('B'));
    expect(nextByLocal.get('C')).toBe(prevByLocal.get('C'));
  });

  it('UNIT-074: output length equals total utterances across all chunks', () => {
    const chunks = [
      { chunkStartMs: 0,      utterances: [utterance('A', 0, 5000), utterance('B', 5000, 10000)] },
      { chunkStartMs: 10_000, utterances: [utterance('A', 9800, 14000)] },
      { chunkStartMs: 20_000, utterances: [utterance('B', 19800, 23000), utterance('A', 23000, 25000)] },
    ];
    const total = chunks.reduce((s, c) => s + c.utterances.length, 0);
    const result = stitchStreamLabels(chunks);
    expect(result).toHaveLength(total);
  });

  it('UNIT-075: all-silent chunks (empty utterances) handled without error', () => {
    const chunks = [
      { chunkStartMs: 0, utterances: [] },
      { chunkStartMs: 10_000, utterances: [] },
    ];
    expect(() => stitchStreamLabels(chunks)).not.toThrow();
    expect(stitchStreamLabels(chunks)).toHaveLength(0);
  });
});

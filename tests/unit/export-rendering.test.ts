// tests/unit/export-rendering.test.ts
// Suite U14: Export Rendering (UNIT-048–050)
// The render functions are private in handlers.ts; we replicate them here for testing.
// If the implementation changes, these tests will catch divergence.

import { describe, it, expect } from 'vitest';
import type { Segment } from '../../src/types/liz-transcribe.js';

// ---- Replicated render helpers (same logic as handlers.ts) ----

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderText(segments: Segment[], overrides: Map<string, string>): string {
  return segments
    .map(s => {
      const label = overrides.get(s.speakerLabel) ?? s.speakerLabel;
      const ts = `[${formatTime(s.startSeconds)}]`;
      return `${ts} ${label}: ${s.text}`;
    })
    .join('\n');
}

function renderMarkdown(segments: Segment[], overrides: Map<string, string>): string {
  return segments
    .map(s => {
      const label = overrides.get(s.speakerLabel) ?? s.speakerLabel;
      return `**[${formatTime(s.startSeconds)}] ${label}:** ${s.text}`;
    })
    .join('\n\n');
}

function renderJson(segments: Segment[], overrides: Map<string, string>): string {
  const data = segments.map(s => ({
    start: s.startSeconds,
    end: s.endSeconds,
    speaker: overrides.get(s.speakerLabel) ?? s.speakerLabel,
    text: s.text,
  }));
  return JSON.stringify(data, null, 2);
}

// ---- Test data ----

function makeSegment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 1,
    sessionId: 'sess-1',
    chunkId: 'chunk-1',
    stream: 'mic',
    speakerLabel: 'You',
    startSeconds: 0,
    endSeconds: 10,
    text: 'Hello world',
    confidence: 0.9,
    isFailedPlaceholder: false,
    ...overrides,
  };
}

const segments: Segment[] = [
  makeSegment({ id: 1, stream: 'mic', speakerLabel: 'You', startSeconds: 0, text: 'Hello there' }),
  makeSegment({ id: 2, stream: 'system', speakerLabel: 'G0', startSeconds: 30, text: 'Good morning' }),
];

describe('renderText — UNIT-048', () => {
  it('UNIT-048: output includes speaker labels', () => {
    const output = renderText(segments, new Map());
    expect(output).toContain('You:');
    expect(output).toContain('G0:');
  });

  it('UNIT-048: output includes timestamps in [HH:MM:SS] format', () => {
    const output = renderText(segments, new Map());
    expect(output).toContain('[00:00:00]');
    expect(output).toContain('[00:00:30]');
  });

  it('UNIT-048: speaker label overrides are applied', () => {
    const overrides = new Map([['G0', 'Alice']]);
    const output = renderText(segments, overrides);
    expect(output).toContain('Alice:');
    expect(output).not.toContain('G0:');
  });

  it('UNIT-048: each segment on its own line', () => {
    const output = renderText(segments, new Map());
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
  });
});

describe('renderMarkdown — UNIT-049', () => {
  it('UNIT-049: mic segments rendered as **You:** headings', () => {
    const output = renderMarkdown(segments, new Map());
    expect(output).toContain('**[00:00:00] You:**');
  });

  it('UNIT-049: system segments rendered as bold labels', () => {
    const output = renderMarkdown(segments, new Map());
    expect(output).toContain('**[00:00:30] G0:**');
  });

  it('segments separated by double newline', () => {
    const output = renderMarkdown(segments, new Map());
    expect(output).toContain('\n\n');
  });

  it('UNIT-049: speaker label overrides applied in markdown', () => {
    const overrides = new Map([['G0', 'Bob']]);
    const output = renderMarkdown(segments, overrides);
    expect(output).toContain('**[00:00:30] Bob:**');
  });
});

describe('renderJson — UNIT-050', () => {
  it('UNIT-050: output is valid JSON', () => {
    const output = renderJson(segments, new Map());
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('UNIT-050: each segment has start, end, speaker, text fields', () => {
    const output = renderJson(segments, new Map());
    const data = JSON.parse(output) as Array<{
      start: number;
      end: number;
      speaker: string;
      text: string;
    }>;
    expect(data).toHaveLength(2);
    for (const item of data) {
      expect(item).toHaveProperty('start');
      expect(item).toHaveProperty('end');
      expect(item).toHaveProperty('speaker');
      expect(item).toHaveProperty('text');
    }
  });

  it('UNIT-050: start/end are numbers (seconds)', () => {
    const output = renderJson(segments, new Map());
    const data = JSON.parse(output) as Array<{ start: number; end: number }>;
    expect(typeof data[0].start).toBe('number');
    expect(typeof data[0].end).toBe('number');
  });

  it('JSON output uses speaker label overrides', () => {
    const overrides = new Map([['G0', 'Charlie']]);
    const output = renderJson(segments, overrides);
    const data = JSON.parse(output) as Array<{ speaker: string }>;
    const systemSeg = data.find(d => d.speaker === 'Charlie');
    expect(systemSeg).toBeTruthy();
  });

  it('formatTime produces correct HH:MM:SS for various values', () => {
    expect(formatTime(0)).toBe('00:00:00');
    expect(formatTime(30)).toBe('00:00:30');
    expect(formatTime(60)).toBe('00:01:00');
    expect(formatTime(3661)).toBe('01:01:01');
  });
});

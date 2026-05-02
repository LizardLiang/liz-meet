// electron/asr/diarization-merge.ts
// Two-stream diarization merge + within-stream speaker-label stitching algorithm.
// Implements §4.7 and §4.7.1 of the tech spec.

import type { Segment, Stream } from '../../src/types/liz-transcribe.js';
import type { RawUtterance } from './provider-interface.js';
import { logger } from '../logging/logger.js';

// ---- Constants for stitching algorithm (§4.7.1) ----
const OVERLAP_WINDOW_MS   = 1_500;
const MIN_OVERLAP_MS      = 100;
const MIN_OVERLAP_RATIO   = 0.30;

// ---- Within-stream stitching ----

interface ChunkUtterances {
  chunkStartMs: number;
  utterances: RawUtterance[];
}

interface GlobalLabeledUtterance extends RawUtterance {
  globalLabel: string;
}

/**
 * Stitch per-chunk local speaker labels into stream-global stable labels.
 * Implements the pseudocode in §4.7.1.
 *
 * Each chunk has utterances with local labels ("A", "B", …) scoped to that chunk.
 * This algorithm maps them to stream-global labels ("G0", "G1", …) such that
 * the same physical speaker gets the same global label across chunks.
 */
export function stitchStreamLabels(chunks: ChunkUtterances[]): GlobalLabeledUtterance[] {
  if (chunks.length === 0) return [];

  // globalAssign[chunkIndex][localLabel] → globalLabel
  const globalAssign: Map<string, string>[] = [];
  let nextGlobalId = 0;

  function newGlobal(): string {
    return `G${nextGlobalId++}`;
  }

  // Chunk 0: every local label gets a fresh global label
  const firstChunkLabels = new Set(chunks[0].utterances.map(u => u.speakerLabel));
  const firstAssign = new Map<string, string>();
  for (const label of firstChunkLabels) {
    firstAssign.set(label, newGlobal());
  }
  globalAssign.push(firstAssign);

  // Chunks 1..K: match against previous chunk's labels
  for (let n = 1; n < chunks.length; n++) {
    const prevChunk = chunks[n - 1];
    const currChunk = chunks[n];
    const boundaryStart = currChunk.chunkStartMs - OVERLAP_WINDOW_MS;
    const boundaryEnd   = currChunk.chunkStartMs + OVERLAP_WINDOW_MS;
    const prevAssign    = globalAssign[n - 1];

    // Compute duration-weighted overlap matrix in the boundary window
    // overlap[currLabel][prevLabel] = total overlap ms
    const overlap = new Map<string, Map<string, number>>();

    for (const up of prevChunk.utterances) {
      if (up.endMs < boundaryStart) continue;
      const clipPStart = Math.max(up.startMs, boundaryStart);
      const clipPEnd   = Math.min(up.endMs, boundaryEnd);
      if (clipPEnd <= clipPStart) continue;

      for (const uc of currChunk.utterances) {
        if (uc.startMs > boundaryEnd) continue;
        const clipCStart = Math.max(uc.startMs, boundaryStart);
        const clipCEnd   = Math.min(uc.endMs, boundaryEnd);
        if (clipCEnd <= clipCStart) continue;

        const ov = Math.max(0, Math.min(clipPEnd, clipCEnd) - Math.max(clipPStart, clipCStart));
        if (ov <= 0) continue;

        if (!overlap.has(uc.speakerLabel)) overlap.set(uc.speakerLabel, new Map());
        const inner = overlap.get(uc.speakerLabel)!;
        inner.set(up.speakerLabel, (inner.get(up.speakerLabel) ?? 0) + ov);
      }
    }

    // Compute window presence for each label (for tie-breaking)
    const windowPresence = (utterances: RawUtterance[], label: string): number => {
      let total = 0;
      for (const u of utterances) {
        if (u.speakerLabel !== label) continue;
        const cs = Math.max(u.startMs, boundaryStart);
        const ce = Math.min(u.endMs, boundaryEnd);
        if (ce > cs) total += ce - cs;
      }
      return total;
    };

    // Flatten overlap matrix to list of (currLabel, prevLabel, overlapMs)
    const pairs: Array<{ curr: string; prev: string; ov: number }> = [];
    for (const [currLabel, prevMap] of overlap) {
      for (const [prevLabel, ov] of prevMap) {
        pairs.push({ curr: currLabel, prev: prevLabel, ov });
      }
    }

    // Sort: primary descending by overlapMs, secondary by shorter-side presence, tertiary lexicographic
    pairs.sort((a, b) => {
      if (b.ov !== a.ov) return b.ov - a.ov;
      const aPresence = Math.min(
        windowPresence(prevChunk.utterances, a.prev),
        windowPresence(currChunk.utterances, a.curr),
      );
      const bPresence = Math.min(
        windowPresence(prevChunk.utterances, b.prev),
        windowPresence(currChunk.utterances, b.curr),
      );
      if (bPresence !== aPresence) return bPresence - aPresence;
      return a.curr.localeCompare(b.curr);
    });

    // Greedy 1:1 assignment
    const matchedCurr = new Set<string>();
    const matchedPrev = new Set<string>();
    const matches = new Map<string, string>();

    for (const { curr, prev, ov } of pairs) {
      if (matchedCurr.has(curr) || matchedPrev.has(prev)) continue;

      // Compute shorter-side duration in boundary window for ratio check
      const currPresence = windowPresence(currChunk.utterances, curr);
      const prevPresence = windowPresence(prevChunk.utterances, prev);
      const shorter = Math.max(1, Math.min(currPresence, prevPresence));

      if (ov < MIN_OVERLAP_MS) continue;
      if (ov / shorter < MIN_OVERLAP_RATIO) continue;

      matches.set(curr, prev);
      matchedCurr.add(curr);
      matchedPrev.add(prev);
    }

    // Assign global labels for this chunk
    const currAssign = new Map<string, string>();
    const currLabels = new Set(currChunk.utterances.map(u => u.speakerLabel));
    for (const currLabel of currLabels) {
      if (matches.has(currLabel)) {
        const prevLabel = matches.get(currLabel)!;
        currAssign.set(currLabel, prevAssign.get(prevLabel)!);
      } else {
        // New speaker — fresh global label, never reused
        currAssign.set(currLabel, newGlobal());
      }
    }
    globalAssign.push(currAssign);
  }

  // Apply globalAssign to produce output
  const out: GlobalLabeledUtterance[] = [];
  for (let n = 0; n < chunks.length; n++) {
    for (const u of chunks[n].utterances) {
      out.push({
        ...u,
        globalLabel: globalAssign[n].get(u.speakerLabel) ?? newGlobal(),
      });
    }
  }
  return out;
}

// ---- Cross-stream merge (§4.7 / §4.7.2) ----

/**
 * Merge mic and system utterances onto a single timeline.
 * - Mic utterances are relabeled "You" (FR-TR-7)
 * - System utterances keep their stitched global labels
 * - Sorted by startMs after applying clock-drift correction
 */
export function mergeStreams(
  micUtterances: RawUtterance[],
  systemUtterances: RawUtterance[],
  sessionId: string,
  micStartWallClock: number,       // ms epoch when mic stream started
  systemStartWallClock: number,    // ms epoch when system stream started
): Omit<Segment, 'id'>[] {
  // Compute drift offset (system - mic in ms)
  const offsetMs = systemStartWallClock - micStartWallClock;

  // Apply offset to system utterances
  const systemAligned = systemUtterances.map(u => ({
    ...u,
    startMs: u.startMs + offsetMs,
    endMs:   u.endMs   + offsetMs,
  }));

  // Log drift warning if exceeds ±200 ms
  const measuredDrift = Math.abs(offsetMs);
  if (measuredDrift > 200) {
    logger.warn({
      event: 'drift_exceeded',
      sessionId,
      driftMs: offsetMs,
    });
  }

  // Relabel mic utterances as "You"
  const micRelabeled = micUtterances.map(u => ({
    ...u,
    speakerLabel: 'You',
    stream: 'mic' as Stream,
  }));

  // Tag system utterances
  const systemTagged = systemAligned.map(u => ({
    ...u,
    stream: 'system' as Stream,
  }));

  // Combine and sort by startMs
  const all = [...micRelabeled, ...systemTagged];
  all.sort((a, b) => a.startMs - b.startMs);

  return all.map(u => ({
    sessionId,
    chunkId: null,
    stream: u.stream as Stream,
    speakerLabel: u.speakerLabel,
    startSeconds: u.startMs / 1000,
    endSeconds:   u.endMs   / 1000,
    text: u.text,
    confidence: u.confidence,
    isFailedPlaceholder: false,
  }));
}

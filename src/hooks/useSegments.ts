// src/hooks/useSegments.ts
// Load segments for a session via IPC.

import { useState, useEffect } from 'react';
import { invokeIpc } from '../lib/ipc.js';
import type { Segment } from '../types/liz-transcribe.js';

export function useSegments(sessionId: string | null): {
  segments: Segment[];
  loading: boolean;
  reload: () => void;
} {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    invokeIpc<Segment[]>('segment:findBySession', { sessionId })
      .then(segs => setSegments(segs))
      .catch(() => void 0)
      .finally(() => setLoading(false));
  }, [sessionId, tick]);

  return { segments, loading, reload: () => setTick(t => t + 1) };
}

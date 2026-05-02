// src/hooks/useStatusChanges.ts
// Subscribe to session:status-changed push events.

import { useEffect } from 'react';
import { onPush } from '../lib/ipc.js';
import type { SessionStatus } from '../types/liz-transcribe.js';

export function useStatusChanges(
  sessionId: string | null,
  onStatusChange: (newStatus: SessionStatus, reason?: string) => void,
): void {
  useEffect(() => {
    if (!sessionId) return;
    const unsub = onPush<{ sessionId: string; newStatus: SessionStatus; reason?: string }>(
      'session:status-changed',
      ({ sessionId: sid, newStatus, reason }) => {
        if (sid === sessionId) onStatusChange(newStatus, reason);
      },
    );
    return unsub;
  }, [sessionId, onStatusChange]);
}

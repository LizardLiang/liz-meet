// src/hooks/useVuMeter.ts
// Subscribe to VU meter updates from main process.

import { useState, useEffect } from 'react';
import { onPush } from '../lib/ipc.js';
import type { Stream } from '../types/liz-transcribe.js';

export function useVuMeter(): { micDb: number; systemDb: number } {
  const [micDb, setMicDb] = useState(-100);
  const [systemDb, setSystemDb] = useState(-100);

  useEffect(() => {
    const unsubMic = onPush<{ stream: Stream; rmsDb: number }>(
      'capture:vu-update',
      ({ stream, rmsDb }) => {
        if (stream === 'mic') setMicDb(rmsDb);
        if (stream === 'system') setSystemDb(rmsDb);
      },
    );
    const unsubSys = onPush<{ rmsDb: number }>(
      'capture:vu-update-system',
      ({ rmsDb }) => setSystemDb(rmsDb),
    );
    return () => { unsubMic(); unsubSys(); };
  }, []);

  return { micDb, systemDb };
}

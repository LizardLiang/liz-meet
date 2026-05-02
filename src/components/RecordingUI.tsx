// src/components/RecordingUI.tsx
// Active recording controls: pulsing indicator, timer, VU meters, Pause/Stop.

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import VuMeter from './VuMeter.js';
import { invokeIpc, onPush } from '../lib/ipc.js';
import type { SessionStatus } from '../types/liz-transcribe.js';

interface Props {
  sessionId: string;
  initialStatus: SessionStatus;
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function RecordingUI({ sessionId, initialStatus }: Props) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SessionStatus>(initialStatus);
  const [elapsed, setElapsed] = useState(0);
  const [micVu, setMicVu] = useState(-100);
  const [systemVu, setSystemVu] = useState(-100);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRecording = status === 'recording';
  const isPaused    = status === 'paused';

  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setElapsed(e => e + 1);
      }, 1_000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  useEffect(() => {
    const unsub = onPush<{ stream: string; rmsDb: number }>('capture:vu-update', ({ stream, rmsDb }) => {
      if (stream === 'mic') setMicVu(rmsDb);
    });
    const unsubSys = onPush<{ rmsDb: number }>('capture:vu-update-system', ({ rmsDb }) => {
      setSystemVu(rmsDb);
    });
    const unsubStatus = onPush<{ sessionId: string; newStatus: SessionStatus }>(
      'session:status-changed',
      ({ sessionId: sid, newStatus }) => {
        if (sid === sessionId) setStatus(newStatus);
      },
    );
    return () => { unsub(); unsubSys(); unsubStatus(); };
  }, [sessionId]);

  const handlePause = async () => {
    await invokeIpc('capture:pause');
  };
  const handleResume = async () => {
    await invokeIpc('capture:resume');
  };
  const handleStop = async () => {
    await invokeIpc('capture:stop');
    navigate('/library');
  };

  if (status !== 'recording' && status !== 'paused') {
    return null;
  }

  return (
    <div className="card bg-base-200 shadow-xl w-full max-w-md mx-auto">
      <div className="card-body gap-4">
        {/* Recording indicator */}
        <div className="flex items-center gap-3">
          <div
            className={`w-4 h-4 rounded-full ${
              isRecording
                ? 'bg-error animate-pulse'
                : 'bg-warning'
            }`}
            aria-hidden="true"
          />
          <span className="font-bold text-lg font-mono" aria-label={`Elapsed: ${formatElapsed(elapsed)}`}>
            {formatElapsed(elapsed)}
          </span>
          <span className="badge badge-outline text-xs">
            {isPaused ? 'Paused' : 'Recording'}
          </span>
        </div>

        {/* VU meters */}
        <div className="flex flex-col gap-2">
          <VuMeter rmsDb={micVu} stream="mic" />
          <VuMeter rmsDb={systemVu} stream="system" />
        </div>

        {/* Controls */}
        <div className="card-actions justify-end gap-2">
          {isRecording && (
            <button className="btn btn-warning btn-sm" onClick={handlePause}>
              Pause
            </button>
          )}
          {isPaused && (
            <button className="btn btn-primary btn-sm" onClick={handleResume}>
              Resume
            </button>
          )}
          <button className="btn btn-error btn-sm" onClick={handleStop}>
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

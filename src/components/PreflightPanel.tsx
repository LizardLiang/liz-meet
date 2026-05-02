// src/components/PreflightPanel.tsx
// Pre-flight panel: mic/system toggles, VU meters, Start button.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import VuMeter from './VuMeter.js';
import { invokeIpc, onPush } from '../lib/ipc.js';
import type { AudioSource } from '../types/liz-transcribe.js';

export default function PreflightPanel() {
  const navigate = useNavigate();
  const [micEnabled, setMicEnabled] = useState(true);
  const [systemEnabled, setSystemEnabled] = useState(false);
  const [apiKeyExists, setApiKeyExists] = useState(false);
  const [micVu, setMicVu] = useState(-100);
  const [systemVu, setSystemVu] = useState(-100);
  const [title, setTitle] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    invokeIpc<boolean>('apikey:exists').then(exists => setApiKeyExists(exists)).catch(() => void 0);
  }, []);

  useEffect(() => {
    const unsubMic = onPush<{ stream: string; rmsDb: number }>('capture:vu-update', ({ stream, rmsDb }) => {
      if (stream === 'mic') setMicVu(rmsDb);
      if (stream === 'system') setSystemVu(rmsDb);
    });
    return unsubMic;
  }, []);

  const source: AudioSource =
    micEnabled && systemEnabled ? 'both' :
    micEnabled ? 'mic' :
    systemEnabled ? 'system' : 'mic';

  const canStart = apiKeyExists && (micEnabled || systemEnabled);

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const result = await invokeIpc<{ sessionId: string }>('capture:start', {
        title: title.trim() || `Session ${new Date().toLocaleString()}`,
        source,
      });
      navigate(`/session/${result.sessionId}?recording=1`);
    } catch {
      setStarting(false);
    }
  };

  return (
    <div className="card bg-base-200 shadow-xl w-full max-w-md mx-auto">
      <div className="card-body gap-4">
        <h2 className="card-title">New Recording</h2>

        <div className="form-control">
          <label className="label"><span className="label-text">Session title</span></label>
          <input
            type="text"
            className="input input-bordered"
            placeholder="Meeting with..."
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        {/* Stream toggles */}
        <div className="flex flex-col gap-2">
          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={micEnabled}
              onChange={e => setMicEnabled(e.target.checked)}
            />
            <span className="label-text">Microphone</span>
          </label>
          {micEnabled && <VuMeter rmsDb={micVu} stream="mic" />}

          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-secondary"
              checked={systemEnabled}
              onChange={e => setSystemEnabled(e.target.checked)}
            />
            <span className="label-text">System audio</span>
          </label>
          {systemEnabled && <VuMeter rmsDb={systemVu} stream="system" />}
        </div>

        {!apiKeyExists && (
          <div className="alert alert-warning">
            <span>No API key configured. Go to Settings to add one.</span>
          </div>
        )}

        <div className="card-actions justify-end">
          <button
            className="btn btn-primary"
            disabled={!canStart || starting}
            onClick={handleStart}
          >
            {starting ? 'Starting...' : 'Start recording'}
          </button>
        </div>
      </div>
    </div>
  );
}

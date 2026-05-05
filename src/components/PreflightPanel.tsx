// src/components/PreflightPanel.tsx
// Pre-flight panel: mic/system toggles, VU meters, Start button.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import VuMeter from './VuMeter.js';
import { invokeIpc, onPush } from '../lib/ipc.js';
import type { AudioSource } from '../types/liz-transcribe.js';

interface MicDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

// Requests getUserMedia to trigger Windows HFP profile switch for Bluetooth mics,
// then immediately releases the stream. Returns true if permission was granted.
async function triggerBluetoothHfp(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch {
    return false;
  }
}

export default function PreflightPanel() {
  const navigate = useNavigate();
  const [micEnabled, setMicEnabled] = useState(true);
  const [systemEnabled, setSystemEnabled] = useState(false);
  const [apiKeyExists, setApiKeyExists] = useState(false);
  const [micVu, setMicVu] = useState(-100);
  const [systemVu, setSystemVu] = useState(-100);
  const [title, setTitle] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    invokeIpc<boolean>('apikey:exists').then(exists => setApiKeyExists(exists)).catch(() => void 0);
  }, []);

  const loadMicDevices = useCallback(async (triggerHfp = false) => {
    if (triggerHfp) await triggerBluetoothHfp();
    try {
      const devices = await invokeIpc<MicDevice[]>('capture:list-mic-devices');
      setMicDevices(devices);
      setSelectedMicId(prev => {
        // Keep existing selection if still present, otherwise pick default
        if (prev && devices.some(d => d.id === prev)) return prev;
        const def = devices.find(d => d.isDefault) ?? devices[0];
        return def?.id ?? null;
      });
    } catch {
      // leave existing list
    }
  }, []);

  // Load mic device list on mount (triggering HFP to pick up Bluetooth mics)
  useEffect(() => {
    void loadMicDevices(true);
  }, [loadMicDevices]);

  const handleRefresh = async () => {
    setRefreshing(true);
    // Stop current preview so WASAPI endpoint isn't held open during re-enum
    await window.ipcRenderer.invoke('capture:mic-preview-stop');
    await loadMicDevices(true);
    setRefreshing(false);
    // Preview will restart via the selectedMicId effect
  };

  useEffect(() => {
    const unsubMic = onPush<{ stream: string; rmsDb: number }>('capture:vu-update', ({ stream, rmsDb }) => {
      const safe = Number.isFinite(rmsDb) ? rmsDb : -100;
      if (stream === 'mic') setMicVu(safe);
      if (stream === 'system') setSystemVu(safe);
    });
    return unsubMic;
  }, []);

  // Native WASAPI loopback preview
  useEffect(() => {
    if (!systemEnabled) { setSystemVu(-100); return; }
    void window.ipcRenderer.invoke('capture:loopback-preview-start');
    return () => {
      void window.ipcRenderer.invoke('capture:loopback-preview-stop');
      setSystemVu(-100);
    };
  }, [systemEnabled]);

  // Native WASAPI mic preview — restarts when device selection or toggle changes
  useEffect(() => {
    if (!micEnabled) {
      setMicVu(-100);
      void window.ipcRenderer.invoke('capture:mic-preview-stop');
      return;
    }
    void window.ipcRenderer.invoke('capture:mic-preview-start', { deviceId: selectedMicId });
    return () => {
      void window.ipcRenderer.invoke('capture:mic-preview-stop');
      setMicVu(-100);
    };
  }, [micEnabled, selectedMicId]);

  // Persist mic device selection to settings
  const handleMicDeviceChange = (id: string) => {
    setSelectedMicId(id);
    invokeIpc('settings:set', { key: 'mic_device_id', value: id }).catch(() => void 0);
  };

  const source: AudioSource =
    micEnabled && systemEnabled ? 'both' :
    micEnabled ? 'mic' :
    systemEnabled ? 'system' : 'mic';

  const canStart = apiKeyExists && (micEnabled || systemEnabled);

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    setStartError(null);
    try {
      const result = await invokeIpc<{ sessionId: string }>('capture:start', {
        title: title.trim() || `Session ${new Date().toLocaleString()}`,
        source,
      });
      navigate(`/recording?session=${result.sessionId}&recording=1&source=${encodeURIComponent(source)}`);
    } catch (err) {
      setStarting(false);
      setStartError(err instanceof Error ? err.message : 'Failed to start recording');
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
          {micEnabled && (
            <>
              <div className="flex gap-2 items-center">
                {micDevices.length > 1 ? (
                  <select
                    className="select select-bordered select-sm flex-1"
                    value={selectedMicId ?? ''}
                    onChange={e => handleMicDeviceChange(e.target.value)}
                  >
                    {micDevices.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                ) : micDevices.length === 1 ? (
                  <span className="text-sm flex-1 truncate">{micDevices[0].name}</span>
                ) : (
                  <span className="text-sm text-warning flex-1">No microphone detected</span>
                )}
                <button
                  className={`btn btn-ghost btn-xs${refreshing ? ' loading' : ''}`}
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Re-scan for microphones (triggers Bluetooth HFP handoff)"
                >
                  {refreshing ? '' : '↺'}
                </button>
              </div>
              <VuMeter rmsDb={micVu} stream="mic" />
            </>
          )}

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
        {startError && (
          <div className="alert alert-error">
            <span>{startError}</span>
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

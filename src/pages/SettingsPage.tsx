// src/pages/SettingsPage.tsx
// Settings panel: chunk duration, provider, audio retention, privacy.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeIpc } from '../lib/ipc.js';
import { NOTICE_TEXT } from '../constants/privacy-notice.js';

export default function SettingsPage() {
  const navigate = useNavigate();
  const [chunkSeconds, setChunkSeconds] = useState(10);
  const [keepRawAudio, setKeepRawAudio] = useState(false);
  const [provider, setProvider] = useState<'assemblyai' | 'nvidia'>('nvidia');
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      invokeIpc<number>('settings:get', { key: 'chunk_seconds' }),
      invokeIpc<boolean>('settings:get', { key: 'keep_raw_audio' }),
      invokeIpc<string>('settings:get', { key: 'provider' }),
    ]).then(([cs, kra, prov]) => {
      if (cs) setChunkSeconds(cs);
      setKeepRawAudio(!!kra);
      if (prov === 'assemblyai' || prov === 'nvidia') setProvider(prov);
    }).catch(() => void 0);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        invokeIpc('settings:set', { key: 'chunk_seconds', value: chunkSeconds }),
        invokeIpc('settings:set', { key: 'keep_raw_audio', value: keepRawAudio }),
        invokeIpc('settings:set', { key: 'provider', value: provider }),
      ]);
    } catch {
      // error
    } finally {
      setSaving(false);
    }
  };

  const handleRevokePrivacy = async () => {
    if (!window.confirm('Revoke privacy acknowledgement? You will need to re-acknowledge before recording.')) return;
    setRevoking(true);
    try {
      await invokeIpc('privacy:revoke');
      navigate('/first-run/privacy');
    } catch {
      setRevoking(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col">
      <div className="sticky top-0 z-10 bg-base-100 border-b border-base-300 px-6 py-4">
        <div className="flex items-center gap-3">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/library')}>
            ← Back
          </button>
          <h1 className="text-2xl font-bold">Settings</h1>
        </div>
      </div>

      <div className="px-6 py-6 max-w-xl flex flex-col gap-8">
        {/* Transcription settings */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Transcription</h2>

          <div className="form-control mb-4">
            <label className="label">
              <span className="label-text">Chunk duration: {chunkSeconds}s</span>
            </label>
            <input
              type="range"
              min="5"
              max="15"
              step="1"
              value={chunkSeconds}
              onChange={e => setChunkSeconds(Number(e.target.value))}
              className="range range-primary"
              aria-label="Chunk duration in seconds"
            />
            <div className="flex justify-between text-xs text-base-content/50 mt-1">
              <span>5s</span><span>15s</span>
            </div>
          </div>

          <div className="form-control mb-4">
            <label className="label">
              <span className="label-text">Transcription provider</span>
            </label>
            <select
              className="select select-bordered w-full max-w-xs"
              value={provider}
              onChange={e => setProvider(e.target.value as 'assemblyai' | 'nvidia')}
            >
              <option value="nvidia">NVIDIA NIM (Parakeet)</option>
              <option value="assemblyai">AssemblyAI</option>
            </select>
            <label className="label">
              <span className="label-text-alt text-base-content/60">
                After switching providers, paste the matching API key below.
              </span>
            </label>
          </div>

          <div className="form-control mb-4">
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="checkbox"
                className="toggle toggle-primary"
                checked={keepRawAudio}
                onChange={e => setKeepRawAudio(e.target.checked)}
              />
              <span className="label-text">Keep raw audio after transcription</span>
            </label>
            <p className="text-xs text-base-content/50 ml-12">
              When disabled, audio files are deleted after successful transcription to save space.
            </p>
          </div>

          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </section>

        {/* API key */}
        <section>
          <h2 className="text-lg font-semibold mb-4">API Key</h2>
          <button
            className="btn btn-outline"
            onClick={() => navigate('/first-run/api-key')}
          >
            Update API key
          </button>
        </section>

        {/* Privacy */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Privacy</h2>
          <button
            className="btn btn-ghost btn-sm mb-4"
            onClick={() => setShowPrivacy(!showPrivacy)}
          >
            {showPrivacy ? 'Hide' : 'View'} current privacy notice
          </button>

          {showPrivacy && (
            <div className="bg-base-300 rounded-lg p-4 mb-4 max-h-64 overflow-y-auto">
              <pre className="whitespace-pre-wrap text-xs font-sans">{NOTICE_TEXT}</pre>
            </div>
          )}

          <button
            className="btn btn-error btn-sm"
            disabled={revoking}
            onClick={handleRevokePrivacy}
          >
            {revoking ? 'Revoking...' : 'Revoke acknowledgement'}
          </button>
          <p className="text-xs text-base-content/50 mt-2">
            Revoking will block recording until you re-acknowledge the privacy notice.
          </p>
        </section>
      </div>
    </div>
  );
}

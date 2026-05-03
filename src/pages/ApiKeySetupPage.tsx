// src/pages/ApiKeySetupPage.tsx
// API key entry screen (Phase 5).

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeIpc } from '../lib/ipc.js';

type TestStatus = 'idle' | 'testing' | 'success' | 'offline-warning' | 'invalid';

const PROVIDER_LABELS: Record<string, { name: string; placeholder: string; dashboardUrl: string }> = {
  nvidia:      { name: 'NVIDIA NIM',   placeholder: 'Paste your NVIDIA API key (nvapi-...)',   dashboardUrl: 'https://build.nvidia.com' },
  assemblyai:  { name: 'AssemblyAI',   placeholder: 'Paste your AssemblyAI API key',           dashboardUrl: 'https://www.assemblyai.com/dashboard' },
  deepgram:    { name: 'Deepgram',     placeholder: 'Paste your Deepgram API key',             dashboardUrl: 'https://console.deepgram.com' },
};

export default function ApiKeySetupPage() {
  const [key, setKey] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState('nvidia');
  const navigate = useNavigate();

  useEffect(() => {
    invokeIpc<string>('settings:get', { key: 'provider' })
      .then(p => { if (p) setProvider(p); })
      .catch(() => {});
  }, []);

  const isKeyFormatValid = key.trim().length >= 10;

  const handleTest = async () => {
    if (!isKeyFormatValid) return;
    setTestStatus('testing');
    try {
      const result = await invokeIpc<{ ok: boolean; error?: string }>('apikey:test', { key: key.trim() });
      if (result.ok) {
        setTestStatus('success');
      } else if (result.error === 'auth_failed') {
        setTestStatus('invalid');
      } else {
        // Network error — non-blocking per §6.4
        setTestStatus('offline-warning');
      }
    } catch {
      setTestStatus('offline-warning');
    }
  };

  const handleContinue = async () => {
    if (!isKeyFormatValid) return;
    setSaving(true);
    try {
      await invokeIpc('apikey:set', { key: key.trim() });
      navigate('/library');
    } catch {
      // Show error
    } finally {
      setSaving(false);
    }
  };

  const providerInfo = PROVIDER_LABELS[provider] ?? PROVIDER_LABELS['assemblyai'];

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col items-center justify-center p-8">
      <div className="card bg-base-200 shadow-xl w-full max-w-lg">
        <div className="card-body">
          <h1 className="card-title text-2xl mb-2">{providerInfo.name} API Key</h1>
          <p className="text-base-content/70 mb-6">
            Enter your {providerInfo.name} API key to enable transcription.{' '}
            <a
              href={providerInfo.dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="link link-primary"
            >
              Get a key
            </a>
          </p>

          <div className="form-control mb-4">
            <label className="label">
              <span className="label-text">API Key</span>
            </label>
            <input
              type="password"
              className="input input-bordered w-full"
              placeholder={providerInfo.placeholder}
              value={key}
              onChange={e => setKey(e.target.value)}
            />
          </div>

          {testStatus === 'success' && (
            <div className="alert alert-success mb-4">
              <span>Connection successful</span>
            </div>
          )}
          {testStatus === 'invalid' && (
            <div className="alert alert-error mb-4">
              <span>Invalid API key — please check and try again</span>
            </div>
          )}
          {testStatus === 'offline-warning' && (
            <div className="alert alert-warning mb-4">
              <span>Could not verify key (network unavailable). You can continue — the key will be tested on first recording.</span>
            </div>
          )}

          <div className="card-actions justify-between">
            <button
              className="btn btn-outline"
              disabled={!isKeyFormatValid || testStatus === 'testing'}
              onClick={handleTest}
            >
              {testStatus === 'testing' ? 'Testing...' : 'Test connection'}
            </button>
            <button
              className="btn btn-primary"
              disabled={!isKeyFormatValid || saving}
              onClick={handleContinue}
            >
              {saving ? 'Saving...' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

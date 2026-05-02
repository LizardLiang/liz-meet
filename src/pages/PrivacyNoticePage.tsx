// src/pages/PrivacyNoticePage.tsx
// First-run privacy notice acknowledgement screen (§5.3.1 / Phase 5).

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeIpc } from '../lib/ipc.js';
import { NOTICE_TEXT, NOTICE_VERSION_HASH } from '../constants/privacy-notice.js';

export default function PrivacyNoticePage() {
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const handleContinue = async () => {
    if (!acknowledged) return;
    setSaving(true);
    try {
      await invokeIpc('privacy:set', {
        noticeHash: NOTICE_VERSION_HASH,
        appVersion: '1.0.0',
      });
      navigate('/first-run/api-key');
    } catch {
      // Error handled by IpcError; show a fallback message
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col items-center justify-center p-8">
      <div className="card bg-base-200 shadow-xl w-full max-w-2xl">
        <div className="card-body">
          <h1 className="card-title text-2xl mb-4">Privacy Notice</h1>
          <div className="bg-base-300 rounded-lg p-4 mb-6 max-h-96 overflow-y-auto">
            <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">
              {NOTICE_TEXT}
            </pre>
          </div>

          <div className="form-control mb-6">
            <label className="label cursor-pointer justify-start gap-4">
              <input
                type="checkbox"
                className="checkbox checkbox-primary"
                checked={acknowledged}
                onChange={e => setAcknowledged(e.target.checked)}
              />
              <span className="label-text">
                I have read and understand the privacy notice above
              </span>
            </label>
          </div>

          <div className="card-actions justify-end">
            <button
              className="btn btn-primary"
              disabled={!acknowledged || saving}
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

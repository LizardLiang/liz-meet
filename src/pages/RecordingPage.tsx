// src/pages/RecordingPage.tsx
// Recording page: shows PreflightPanel before recording, RecordingUI during.

import { useSearchParams } from 'react-router-dom';
import PreflightPanel from '../components/PreflightPanel.js';
import RecordingUI from '../components/RecordingUI.js';
import type { AudioSource } from '../types/liz-transcribe.js';

function parseSource(value: string | null): AudioSource | null {
  if (value === 'mic' || value === 'system' || value === 'both') return value;
  return null;
}

export default function RecordingPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session');
  const recording = searchParams.get('recording') === '1';
  const source = parseSource(searchParams.get('source'));

  if (recording && sessionId) {
    return (
      <div className="min-h-screen bg-base-100 flex items-center justify-center p-8">
        <RecordingUI sessionId={sessionId} initialStatus="recording" source={source} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-100 flex items-center justify-center p-8">
      <PreflightPanel />
    </div>
  );
}

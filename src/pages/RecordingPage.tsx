// src/pages/RecordingPage.tsx
// Recording page: shows PreflightPanel before recording, RecordingUI during.

import { useSearchParams } from 'react-router-dom';
import PreflightPanel from '../components/PreflightPanel.js';
import RecordingUI from '../components/RecordingUI.js';

export default function RecordingPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session');
  const recording = searchParams.get('recording') === '1';

  if (recording && sessionId) {
    return (
      <div className="min-h-screen bg-base-100 flex items-center justify-center p-8">
        <RecordingUI sessionId={sessionId} initialStatus="recording" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-100 flex items-center justify-center p-8">
      <PreflightPanel />
    </div>
  );
}

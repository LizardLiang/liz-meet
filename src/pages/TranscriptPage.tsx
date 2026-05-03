// src/pages/TranscriptPage.tsx
// Transcript viewer page with speaker labels, retry, copy, export.

import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import TranscriptSegment from '../components/TranscriptSegment.js';
import SpeakerLabelEditor from '../components/SpeakerLabelEditor.js';
import SessionHeader from '../components/SessionHeader.js';
import CopyButton from '../components/CopyButton.js';
import ExportMenu from '../components/ExportMenu.js';
import RecordingUI from '../components/RecordingUI.js';
import { invokeIpc, onPush } from '../lib/ipc.js';
import type { Session, Segment, SessionStatus } from '../types/liz-transcribe.js';

export default function TranscriptPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const targetSegId = searchParams.get('seg') ? Number(searchParams.get('seg')) : null;

  const [session, setSession] = useState<Session | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [labelOverrides, setLabelOverrides] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const targetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      invokeIpc<Session | null>('session:get', { id }),
      invokeIpc<Segment[]>('segment:findBySession', { sessionId: id }),
      invokeIpc<Array<{ originalLabel: string; customLabel: string }>>('speakerLabel:list', { sessionId: id }),
    ])
      .then(([sess, segs, overrides]) => {
        setSession(sess);
        setSegments(segs);
        const map = new Map(overrides.map(o => [o.originalLabel, o.customLabel]));
        setLabelOverrides(map);
      })
      .catch(() => void 0)
      .finally(() => setLoading(false));
  }, [id]);

  // Scroll to target segment on load
  useEffect(() => {
    if (targetSegId && targetRef.current) {
      targetRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [targetSegId, segments]);

  // Listen for status changes
  useEffect(() => {
    const unsub = onPush<{ sessionId: string; newStatus: SessionStatus }>(
      'session:status-changed',
      ({ sessionId, newStatus }) => {
        if (sessionId === id) {
          setSession(prev => prev ? { ...prev, status: newStatus } : prev);
          if (newStatus === 'completed' || newStatus === 'completed_with_failures') {
            // Reload segments
            invokeIpc<Segment[]>('segment:findBySession', { sessionId })
              .then(segs => setSegments(segs))
              .catch(() => void 0);
          }
        }
      },
    );
    return unsub;
  }, [id]);

  const handleRetry = async (chunkId: string) => {
    try {
      await invokeIpc('transcript:retry-chunk', { chunkId });
    } catch {
      // show toast
    }
  };

  const handleLabelRenamed = (originalLabel: string, newLabel: string) => {
    setLabelOverrides(prev => new Map(prev).set(originalLabel, newLabel));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-base-100 flex items-center justify-center">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-base-100 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg mb-4">Session not found</p>
          <button className="btn btn-primary" onClick={() => navigate('/library')}>
            Back to library
          </button>
        </div>
      </div>
    );
  }

  const isLive = session.status === 'recording' || session.status === 'paused';
  const isProcessing = session.status === 'processing';

  // Collect unique speaker labels
  const speakerLabels = Array.from(new Set(segments.map(s => s.speakerLabel)));

  return (
    <div className="min-h-screen bg-base-100 flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-base-100 border-b border-base-300 px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <button
              className="btn btn-ghost btn-sm mb-2"
              onClick={() => navigate('/library')}
            >
              ← Back
            </button>
            <SessionHeader session={session} onUpdated={setSession} />
          </div>
          <div className="flex items-center gap-2 shrink-0 mt-8">
            {segments.length > 0 && (
              <>
                <CopyButton segments={segments} labelOverrides={labelOverrides} />
                <ExportMenu sessionId={session.id} />
              </>
            )}
          </div>
        </div>

        {/* Speaker rename row */}
        {speakerLabels.length > 0 && (
          <div className="flex flex-wrap gap-3 mt-2">
            {speakerLabels.map(label => (
              <SpeakerLabelEditor
                key={label}
                sessionId={session.id}
                originalLabel={label}
                currentLabel={labelOverrides.get(label) ?? label}
                onRenamed={handleLabelRenamed}
              />
            ))}
          </div>
        )}
      </div>

      {/* Live recording controls */}
      {isLive && (
        <div className="px-6 pt-4">
          <RecordingUI sessionId={session.id} initialStatus={session.status} />
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isProcessing ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <span className="loading loading-spinner loading-lg" />
            <p className="text-base-content/60">Transcribing...</p>
          </div>
        ) : segments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <p className="text-base-content/50">No transcript available</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {segments.map(seg => {
              const displayLabel = labelOverrides.get(seg.speakerLabel) ?? seg.speakerLabel;
              const isTarget = seg.id === targetSegId;
              return (
                <div key={seg.id} ref={isTarget ? (el => { targetRef.current = el; }) : undefined}>
                  <TranscriptSegment
                    segment={seg}
                    displayLabel={displayLabel}
                    highlighted={isTarget}
                    onRetry={handleRetry}
                    rawAudioAvailable={session.rawAudioPath !== null}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

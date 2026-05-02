// src/components/TranscriptSegment.tsx
// Renders a single transcript segment with speaker label, timestamp, and text.
// Mic-stream "You" segments get a non-color marker (bold + icon) per FR-UX-3.

import type { Segment } from '../types/liz-transcribe.js';
import RetryPanel from './RetryPanel.js';

interface Props {
  segment: Segment;
  displayLabel: string;
  highlighted?: boolean;
  onRetry?: (chunkId: string) => void;
  rawAudioAvailable?: boolean;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function TranscriptSegment({
  segment,
  displayLabel,
  highlighted = false,
  onRetry,
  rawAudioAvailable = true,
}: Props) {
  const isYou = segment.stream === 'mic';
  const isFailed = segment.isFailedPlaceholder;

  return (
    <div
      id={`seg-${segment.id}`}
      className={`flex gap-3 py-2 px-3 rounded-lg transition-colors ${
        highlighted ? 'bg-yellow-50 dark:bg-yellow-900/20' : 'hover:bg-base-200/50'
      }`}
    >
      {/* Speaker label + timestamp column */}
      <div className="shrink-0 w-28 pt-0.5">
        <div className="flex items-center gap-1">
          {/* Non-color marker for mic/"You" segments — FR-UX-3 accessibility */}
          {isYou && (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-3.5 h-3.5 shrink-0"
              aria-hidden="true"
            >
              <path d="M10 8a3 3 0 100-6 3 3 0 000 6zM3.465 14.493a1.23 1.23 0 00.41 1.412A9.957 9.957 0 0010 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 00-13.074.003z" />
            </svg>
          )}
          <span className={`text-xs font-semibold truncate ${isYou ? 'font-bold' : ''}`}>
            {displayLabel}
          </span>
        </div>
        <div className="text-xs text-base-content/40 mt-0.5">
          {formatTime(segment.startSeconds)}
        </div>
      </div>

      {/* Text column */}
      <div className="flex-1 min-w-0">
        {isFailed ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base-content/40 text-sm italic">{segment.text}</span>
            {segment.chunkId && onRetry && (
              <RetryPanel
                chunkId={segment.chunkId}
                mode="single"
                onRetry={onRetry}
                disabled={!rawAudioAvailable}
              />
            )}
          </div>
        ) : (
          <p className="text-sm leading-relaxed">{segment.text}</p>
        )}
      </div>
    </div>
  );
}

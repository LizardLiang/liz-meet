// src/components/SessionCard.tsx
// Session card for the library page.

import type { Session, SessionStatus } from '../types/liz-transcribe.js';

interface Props {
  session: Session;
  onClick: () => void;
  onDelete: () => void;
}

const STATUS_BADGE: Record<SessionStatus, { cls: string; label: string }> = {
  recording:              { cls: 'badge-error',   label: 'Recording' },
  paused:                 { cls: 'badge-warning',  label: 'Paused' },
  processing:             { cls: 'badge-info',     label: 'Processing' },
  completed:              { cls: 'badge-success',  label: 'Completed' },
  completed_with_failures:{ cls: 'badge-warning',  label: 'Completed (with gaps)' },
  failed:                 { cls: 'badge-error',    label: 'Failed' },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}h ${m}m`
    : m > 0
    ? `${m}m ${s}s`
    : `${s}s`;
}

export default function SessionCard({ session, onClick, onDelete }: Props) {
  const badge = STATUS_BADGE[session.status];

  return (
    <div
      className="card bg-base-200 shadow hover:shadow-md transition-shadow cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-label={`Open session: ${session.title}`}
    >
      <div className="card-body p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="card-title text-base line-clamp-2 flex-1">
            {session.title || 'Untitled session'}
          </h2>
          <span className={`badge ${badge.cls} shrink-0`}>{badge.label}</span>
        </div>

        <div className="text-sm text-base-content/60 mt-1">
          <span>{formatDate(session.createdAt)}</span>
          {session.durationSeconds != null && (
            <span className="ml-2">· {formatDuration(session.durationSeconds)}</span>
          )}
          {session.speakerCount != null && (
            <span className="ml-2">
              · {session.speakerCount} speaker{session.speakerCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="card-actions justify-end mt-2">
          <button
            className="btn btn-ghost btn-xs text-error"
            onClick={e => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Delete session"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

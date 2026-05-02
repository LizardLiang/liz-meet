// src/components/RetryPanel.tsx
// Retry button(s) for failed-chunk segments.

interface Props {
  chunkId?: string;
  sessionId?: string;
  mode: 'single' | 'all';
  onRetry: (chunkId: string) => void;
  disabled?: boolean;
}

export default function RetryPanel({ chunkId, mode, onRetry, disabled = false }: Props) {
  const label = mode === 'single' ? 'Retry' : 'Retry all failed';

  return (
    <div className="relative group">
      <button
        className="btn btn-outline btn-xs"
        disabled={disabled}
        onClick={() => {
          if (!disabled && chunkId) onRetry(chunkId);
        }}
        aria-disabled={disabled}
        aria-label={label}
      >
        {label}
      </button>
      {disabled && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs bg-base-300 rounded shadow whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
          Audio file deleted — retry unavailable
        </div>
      )}
    </div>
  );
}

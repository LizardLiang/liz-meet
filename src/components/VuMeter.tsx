// src/components/VuMeter.tsx
// Visual VU meter with numeric readout (accessibility §5.4).

interface Props {
  rmsDb: number;
  stream: 'mic' | 'system';
}

/** Map dBFS (-100..0) to percentage (0..100) */
function dbToPercent(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db));
  return ((clamped + 60) / 60) * 100;
}

export default function VuMeter({ rmsDb, stream }: Props) {
  const percent = dbToPercent(rmsDb);
  const label = stream === 'mic' ? 'Microphone' : 'System audio';
  const displayDb = rmsDb <= -60 ? '-∞' : `${rmsDb.toFixed(1)} dB`;

  return (
    <div className="flex flex-col gap-1" role="meter" aria-label={`${label} level`} aria-valuenow={Math.round(rmsDb)} aria-valuemin={-60} aria-valuemax={0}>
      <div className="flex items-center justify-between text-xs text-base-content/60">
        <span>{label}</span>
        <span aria-hidden="true">{displayDb}</span>
      </div>
      <div className="w-full bg-base-300 rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-75 ${
            percent > 80 ? 'bg-error' :
            percent > 60 ? 'bg-warning' :
                           'bg-success'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {/* Screen-reader text */}
      <span className="sr-only">{label}: {displayDb}</span>
    </div>
  );
}

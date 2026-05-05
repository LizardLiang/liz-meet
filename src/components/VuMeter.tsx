// src/components/VuMeter.tsx
// Visual VU meter with numeric readout (accessibility §5.4).

interface Props {
  rmsDb: number;
  stream: 'mic' | 'system';
}

// Floor for each stream. Raw WASAPI loopback (no AGC) sits around -60 to -90 dBFS;
// a -90 floor makes that range visible. Mic (naudiodon2) is louder so -60 is fine.
const FLOOR: Record<'mic' | 'system', number> = { mic: -60, system: -90 };

/** Map dBFS to percentage (0..100) using stream-specific floor. */
function dbToPercent(db: number, floor: number): number {
  const safe = Number.isFinite(db) ? db : -100;
  const clamped = Math.max(floor, Math.min(0, safe));
  return ((clamped - floor) / -floor) * 100;
}

export default function VuMeter({ rmsDb, stream }: Props) {
  const floor   = FLOOR[stream];
  const safeDb  = Number.isFinite(rmsDb) ? rmsDb : -100;
  const percent = dbToPercent(safeDb, floor);
  const label   = stream === 'mic' ? 'Microphone' : 'System audio';
  const displayDb = safeDb <= floor ? '-∞' : `${safeDb.toFixed(1)} dB`;

  return (
    <div className="flex flex-col gap-1" role="meter" aria-label={`${label} level`} aria-valuenow={Math.round(safeDb)} aria-valuemin={floor} aria-valuemax={0}>
      <div className="flex items-center justify-between text-xs text-base-content/60">
        <span>{label}</span>
        <span aria-hidden="true">{displayDb}</span>
      </div>
      <div className="w-full bg-base-300 rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full ${
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

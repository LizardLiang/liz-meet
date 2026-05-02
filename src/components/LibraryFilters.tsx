// src/components/LibraryFilters.tsx
// Date range and status filter controls.

import type { SessionStatus } from '../types/liz-transcribe.js';

const STATUS_OPTIONS: { value: SessionStatus; label: string }[] = [
  { value: 'recording',              label: 'Recording' },
  { value: 'paused',                 label: 'Paused' },
  { value: 'processing',             label: 'Processing' },
  { value: 'completed',              label: 'Completed' },
  { value: 'completed_with_failures',label: 'Completed (with gaps)' },
  { value: 'failed',                 label: 'Failed' },
];

export interface FilterState {
  status: SessionStatus | '';
  dateFrom: string;
  dateTo: string;
}

interface Props {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}

export default function LibraryFilters({ filters, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-3 items-center">
      <select
        className="select select-bordered select-sm"
        value={filters.status}
        onChange={e => onChange({ ...filters, status: e.target.value as SessionStatus | '' })}
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {STATUS_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      <input
        type="date"
        className="input input-bordered input-sm"
        value={filters.dateFrom}
        onChange={e => onChange({ ...filters, dateFrom: e.target.value })}
        aria-label="From date"
      />
      <span className="text-base-content/50 text-sm">–</span>
      <input
        type="date"
        className="input input-bordered input-sm"
        value={filters.dateTo}
        onChange={e => onChange({ ...filters, dateTo: e.target.value })}
        aria-label="To date"
      />

      {(filters.status || filters.dateFrom || filters.dateTo) && (
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => onChange({ status: '', dateFrom: '', dateTo: '' })}
        >
          Clear
        </button>
      )}
    </div>
  );
}

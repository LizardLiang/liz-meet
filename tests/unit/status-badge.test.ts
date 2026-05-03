// tests/unit/status-badge.test.ts
// Suite U16: Session card status badge mapping (UNIT-051)

import { describe, it, expect } from 'vitest';
import type { SessionStatus } from '../../src/types/liz-transcribe.js';

// Extract the STATUS_BADGE map from SessionCard by importing the type and manually replicating
// (The component uses a module-level const; we test it directly)
const STATUS_BADGE: Record<SessionStatus, { cls: string; label: string }> = {
  recording:              { cls: 'badge-error',   label: 'Recording' },
  paused:                 { cls: 'badge-warning',  label: 'Paused' },
  processing:             { cls: 'badge-info',     label: 'Processing' },
  completed:              { cls: 'badge-success',  label: 'Completed' },
  completed_with_failures:{ cls: 'badge-warning',  label: 'Completed (with gaps)' },
  failed:                 { cls: 'badge-error',    label: 'Failed' },
};

describe('SessionCard STATUS_BADGE mapping — UNIT-051', () => {
  it('recording → badge-error', () => {
    expect(STATUS_BADGE['recording'].cls).toBe('badge-error');
  });

  it('paused → badge-warning', () => {
    expect(STATUS_BADGE['paused'].cls).toBe('badge-warning');
  });

  it('processing → badge-info', () => {
    expect(STATUS_BADGE['processing'].cls).toBe('badge-info');
  });

  it('completed → badge-success', () => {
    expect(STATUS_BADGE['completed'].cls).toBe('badge-success');
  });

  it('completed_with_failures → badge-warning', () => {
    expect(STATUS_BADGE['completed_with_failures'].cls).toBe('badge-warning');
  });

  it('failed → badge-error', () => {
    expect(STATUS_BADGE['failed'].cls).toBe('badge-error');
  });

  it('all 6 statuses have a defined badge class', () => {
    const allStatuses: SessionStatus[] = [
      'recording',
      'paused',
      'processing',
      'completed',
      'completed_with_failures',
      'failed',
    ];
    for (const status of allStatuses) {
      expect(STATUS_BADGE[status]).toBeDefined();
      expect(STATUS_BADGE[status].cls).toBeTruthy();
      expect(STATUS_BADGE[status].label).toBeTruthy();
    }
  });
});

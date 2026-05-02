// electron/services/privacy-service.ts
// Privacy acknowledgement persistence.
// Stores { noticeHash, timestamp, appVersion } in the settings table.

import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { SettingsRepository } from '../db/settings-repository.js';

const ACK_KEY = 'privacy_acknowledgement';

export interface PrivacyAck {
  noticeHash: string;
  timestamp: string;
  appVersion: string;
}

export class PrivacyService {
  constructor(private settingsRepo: SettingsRepository) {}

  /**
   * Returns true if the user has acknowledged the current notice version.
   * Hash mismatch → re-acknowledgement required.
   */
  isAcknowledged(currentNoticeHash: string): boolean {
    try {
      const stored = this.settingsRepo.get<PrivacyAck>(ACK_KEY);
      return stored?.noticeHash === currentNoticeHash;
    } catch {
      return false;
    }
  }

  /** Persist the acknowledgement record. */
  acknowledge(noticeHash: string): void {
    const ack: PrivacyAck = {
      noticeHash,
      timestamp: new Date().toISOString(),
      appVersion: app.getVersion(),
    };
    this.settingsRepo.set(ACK_KEY, ack);
  }

  /** Revoke the acknowledgement — blocks recording until re-acknowledged. */
  revoke(): void {
    this.settingsRepo.set(ACK_KEY, null);
  }

  getStoredAck(): PrivacyAck | null {
    try {
      return this.settingsRepo.get<PrivacyAck>(ACK_KEY);
    } catch {
      return null;
    }
  }
}

/** Compute SHA-256 hash of the notice text (used as the notice version identifier). */
export function hashNoticeText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

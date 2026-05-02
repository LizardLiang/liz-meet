// electron/capture/device-monitor.ts
// Monitors for audio device hot-swap events.
// naudiodon2 emits errors on device removal (handled in mic-recorder.ts).
// This module provides the Windows Audio service restart retry logic.

import { logger } from '../logging/logger.js';
import { MicRecorder } from './mic-recorder.js';

const RETRY_INTERVAL_MS = 2_000;
const MAX_RETRY_DURATION_MS = 30_000;

export class DeviceMonitor {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private retryStart = 0;
  private onRestored: (() => void) | null = null;

  /**
   * Begin polling for device restoration.
   * Calls onRestored() when the device comes back online.
   * Stops after 30 seconds if not restored.
   */
  startRetry(onRestored: () => void, onFailed?: () => void): void {
    this.stopRetry();
    this.retryStart = Date.now();
    this.onRestored = onRestored;

    this.retryTimer = setInterval(() => {
      const elapsed = Date.now() - this.retryStart;
      if (elapsed > MAX_RETRY_DURATION_MS) {
        this.stopRetry();
        logger.warn({ event: 'device_restore_timeout' });
        onFailed?.();
        return;
      }

      try {
        const devices = MicRecorder.getDevices();
        const hasMic = devices.some(d => d.maxInputChannels > 0);
        if (hasMic) {
          this.stopRetry();
          logger.info({ event: 'device_restored' });
          this.onRestored?.();
        }
      } catch {
        // Device still unavailable; keep retrying
      }
    }, RETRY_INTERVAL_MS);
  }

  stopRetry(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

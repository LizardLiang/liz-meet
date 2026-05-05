// electron/capture/preflight.ts
// Pre-flight checks before starting recording.

import { MicRecorder } from './mic-recorder.js';
import { apiKeyService } from '../services/api-key-service.js';
import type { PreflightResult } from '../../src/types/liz-transcribe.js';
import { logger } from '../logging/logger.js';

export async function runPreflight(): Promise<PreflightResult> {
  let micAvailable = false;
  let apiKeyExists = false;
  const loopbackReady = true;

  // Check mic — WASAPI capture endpoint enumeration
  try {
    const devices = MicRecorder.listDevices();
    micAvailable = devices.length > 0;
  } catch {
    micAvailable = false;
  }

  // Check API key
  try {
    apiKeyExists = apiKeyService.exists();
  } catch {
    apiKeyExists = false;
  }

  const result: PreflightResult = {
    ok: micAvailable && apiKeyExists,
    micAvailable,
    systemAudioSilent: false,
    apiKeyExists,
    loopbackReady,
  };

  logger.info({ event: 'preflight', micAvailable, apiKeyExists });
  return result;
}

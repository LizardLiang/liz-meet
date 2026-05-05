// tests/unit/preflight.test.ts
// Suite U3: Preflight Checks (UNIT-031, UNIT-032)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userData' },
}));

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../electron/capture/mic-recorder.js', () => ({
  MicRecorder: {
    listDevices: vi.fn(),
  },
}));

vi.mock('../../electron/services/api-key-service.js', () => ({
  apiKeyService: {
    exists: vi.fn(() => false),
  },
}));

import { runPreflight } from '../../electron/capture/preflight.js';
import { MicRecorder } from '../../electron/capture/mic-recorder.js';
import { apiKeyService } from '../../electron/services/api-key-service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

const fakeMic = { id: '{dev-guid}', name: 'Microphone', isDefault: true };

describe('runPreflight', () => {
  it('UNIT-031: no mic device detected → micAvailable=false', async () => {
    vi.mocked(MicRecorder.listDevices).mockReturnValue([]);
    vi.mocked(apiKeyService.exists).mockReturnValue(true);

    const result = await runPreflight();

    expect(result.micAvailable).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('UNIT-031: at least one capture device → micAvailable=true', async () => {
    vi.mocked(MicRecorder.listDevices).mockReturnValue([fakeMic]);
    vi.mocked(apiKeyService.exists).mockReturnValue(true);

    const result = await runPreflight();

    expect(result.micAvailable).toBe(true);
  });

  it('UNIT-032: systemAudioSilent defaults to false (renderer-side check)', async () => {
    vi.mocked(MicRecorder.listDevices).mockReturnValue([fakeMic]);
    vi.mocked(apiKeyService.exists).mockReturnValue(true);

    const result = await runPreflight();

    expect(result.systemAudioSilent).toBe(false);
  });

  it('mic detection throws → micAvailable=false (graceful)', async () => {
    vi.mocked(MicRecorder.listDevices).mockImplementation(() => {
      throw new Error('WASAPI not available');
    });
    vi.mocked(apiKeyService.exists).mockReturnValue(true);

    const result = await runPreflight();

    expect(result.micAvailable).toBe(false);
  });

  it('all ok when mic available and api key exists', async () => {
    vi.mocked(MicRecorder.listDevices).mockReturnValue([fakeMic]);
    vi.mocked(apiKeyService.exists).mockReturnValue(true);

    const result = await runPreflight();

    expect(result.ok).toBe(true);
    expect(result.micAvailable).toBe(true);
    expect(result.apiKeyExists).toBe(true);
    expect(result.loopbackReady).toBe(true);
  });

  it('apiKeyExists=false → ok=false', async () => {
    vi.mocked(MicRecorder.listDevices).mockReturnValue([fakeMic]);
    vi.mocked(apiKeyService.exists).mockReturnValue(false);

    const result = await runPreflight();

    expect(result.apiKeyExists).toBe(false);
    expect(result.ok).toBe(false);
  });
});

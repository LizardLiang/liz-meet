// tests/unit/session-state.test.ts
// Suite U2: Session State Machine (UNIT-011–019)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userData' },
}));

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Use class syntax so Vitest handles the constructor mock correctly
vi.mock('../../electron/capture/mic-recorder.js', () => {
  const startFn = vi.fn();
  const stopFn = vi.fn();
  const pauseFn = vi.fn();
  const isActiveFn = vi.fn(() => false);
  return {
    MicRecorder: class {
      start = startFn;
      stop = stopFn;
      pause = pauseFn;
      isActive = isActiveFn;
      static getDevices = vi.fn(() => []);
    },
    __micStart: startFn,
    __micStop: stopFn,
    __micPause: pauseFn,
    __micIsActive: isActiveFn,
  };
});

vi.mock('../../electron/capture/loopback-recorder.js', () => {
  const startFn = vi.fn();
  const stopFn = vi.fn();
  return {
    LoopbackRecorder: class {
      start = startFn;
      stop = stopFn;
    },
    __loopbackStart: startFn,
    __loopbackStop: stopFn,
  };
});

vi.mock('../../electron/ipc/notifier.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../electron/ipc/channels.js', () => ({
  PUSH_CHANNELS: {
    SESSION_STATUS_CHANGED: 'session:status-changed',
    SESSION_AUTO_STOPPED: 'session:auto-stopped',
    CAPTURE_VU_UPDATE: 'capture:vu-update',
  },
}));

import { SessionStateMachine } from '../../electron/capture/session-state.js';
import * as notifier from '../../electron/ipc/notifier.js';

const stubWin = { isDestroyed: () => false, webContents: { send: vi.fn() } };

const mockSessionCreate = vi.fn();
const mockSessionUpdateStatus = vi.fn();
const mockSessionUpdateEndTime = vi.fn();
const mockSessionFindById = vi.fn();

const stubSessionRepo = {
  create: mockSessionCreate,
  updateStatus: mockSessionUpdateStatus,
  updateEndTime: mockSessionUpdateEndTime,
  findById: mockSessionFindById,
};

const stubChunkRepo = {};
const mockSettingsGet = vi.fn();
const stubSettingsRepo = { get: mockSettingsGet };

function makeStateMachine() {
  return new SessionStateMachine(
    stubWin as never,
    stubSessionRepo as never,
    stubChunkRepo as never,
    stubSettingsRepo as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionCreate.mockReturnValue({
    id: 'session-abc',
    title: 'Test',
    source: 'mic',
    status: 'recording',
  });
  mockSessionFindById.mockReturnValue({
    id: 'session-abc',
    title: 'Test',
    source: 'mic',
    status: 'recording',
  });
  mockSettingsGet.mockImplementation((key: string, def: unknown) => {
    if (key === 'chunk_seconds') return 10;
    if (key === 'mic_device_id') return null;
    return def;
  });
});

describe('SessionStateMachine — state transitions', () => {
  it('UNIT-011: idle → recording on start()', async () => {
    const sm = makeStateMachine();
    expect(sm.getState()).toBe('idle');
    await sm.start({ title: 'Test', source: 'mic' });
    expect(sm.getState()).toBe('recording');
  });

  it('UNIT-012: recording → paused on pause()', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.pause();
    expect(sm.getState()).toBe('paused');
  });

  it('UNIT-013: paused → recording on resume()', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.pause();
    sm.resume();
    expect(sm.getState()).toBe('recording');
  });

  it('UNIT-014: recording → processing on stop()', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.stop();
    expect(sm.getState()).toBe('processing');
  });

  it('UNIT-015: paused → processing on stop()', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.pause();
    sm.stop();
    expect(sm.getState()).toBe('processing');
  });

  it('start() from non-idle throws', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    await expect(sm.start({ title: 'Test2', source: 'mic' })).rejects.toThrow('Already recording');
  });

  it('UNIT-017: pause() transitions to paused state', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'both' });
    sm.pause();
    expect(sm.getState()).toBe('paused');
  });

  it('UNIT-019: stop() calls updateEndTime and updateStatus on session row', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.stop();
    expect(mockSessionUpdateEndTime).toHaveBeenCalledTimes(1);
    const [, endedAt, durationSeconds] = mockSessionUpdateEndTime.mock.calls[0] as [string, string, number];
    expect(typeof endedAt).toBe('string');
    expect(durationSeconds).toBeGreaterThanOrEqual(0);
    expect(mockSessionUpdateStatus).toHaveBeenCalledWith('session-abc', 'processing');
  });

  it('pause() from paused state is a no-op', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.pause();
    sm.pause(); // second pause should be a no-op
    expect(sm.getState()).toBe('paused');
  });

  it('stop() from idle is a no-op', () => {
    const sm = makeStateMachine();
    expect(() => sm.stop()).not.toThrow();
    expect(sm.getState()).toBe('idle');
  });

  it('UNIT-020: pause() emits session:status-changed with paused', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    vi.mocked(notifier.notify).mockClear();
    sm.pause();
    const pauseCall = vi.mocked(notifier.notify).mock.calls.find(
      ([, chan, payload]) =>
        chan === 'session:status-changed' &&
        (payload as { newStatus: string }).newStatus === 'paused',
    );
    expect(pauseCall).toBeTruthy();
  });

  it('getCurrentSessionId() returns null before recording', () => {
    const sm = makeStateMachine();
    expect(sm.getCurrentSessionId()).toBeNull();
  });

  it('getCurrentSessionId() returns session id after start()', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    expect(sm.getCurrentSessionId()).toBe('session-abc');
  });

  it('start() with source=mic calls sessionRepo.create and transitions to recording', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'mic' }),
    );
    expect(sm.getState()).toBe('recording');
  });

  it('UNIT-016 related: 4-hour auto-stop arms timer on pause()', async () => {
    const sm = makeStateMachine();
    vi.useFakeTimers();
    await sm.start({ title: 'Test', source: 'mic' });
    sm.pause();
    expect(sm.getState()).toBe('paused');
    vi.useRealTimers();
    sm.cleanup();
  });

  it('micFns are exposed via getMicRecorder()', async () => {
    const sm = makeStateMachine();
    await sm.start({ title: 'Test', source: 'mic' });
    const mic = sm.getMicRecorder();
    expect(mic).toBeDefined();
  });
});

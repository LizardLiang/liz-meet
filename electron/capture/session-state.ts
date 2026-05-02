// electron/capture/session-state.ts
// Session state machine: idle → recording → paused → processing

import type { BrowserWindow } from 'electron';
import type { SessionRepository } from '../db/session-repository.js';
import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SettingsRepository } from '../db/settings-repository.js';
import { MicRecorder } from './mic-recorder.js';
import { LoopbackRecorder } from './loopback-recorder.js';
import { notify } from '../ipc/notifier.js';
import { PUSH_CHANNELS } from '../ipc/channels.js';
import type { AudioSource, SessionStatus } from '../../src/types/liz-transcribe.js';
import { logger } from '../logging/logger.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SLEEP_THRESHOLD_MS = 30_000;

type CaptureState = 'idle' | 'recording' | 'paused' | 'processing';

export class SessionStateMachine {
  private state: CaptureState = 'idle';
  private currentSessionId: string | null = null;
  private micRecorder: MicRecorder;
  private loopbackRecorder: LoopbackRecorder;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepWatchdog: ReturnType<typeof setInterval> | null = null;
  private sessionStartTime = 0;

  constructor(
    private win: BrowserWindow,
    private sessionRepo: SessionRepository,
    private readonly _chunkRepo: ChunkRepository,
    private settingsRepo: SettingsRepository,
  ) {
    void this._chunkRepo; // used by mic/loopback recorders
    this.micRecorder = new MicRecorder(win, _chunkRepo);
    this.loopbackRecorder = new LoopbackRecorder(_chunkRepo);
  }

  getState(): CaptureState {
    return this.state;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getMicRecorder(): MicRecorder {
    return this.micRecorder;
  }

  getLoopbackRecorder(): LoopbackRecorder {
    return this.loopbackRecorder;
  }

  async start(args: { title: string; source: AudioSource }): Promise<{ sessionId: string }> {
    if (this.state !== 'idle') throw new Error('Already recording');

    const session = this.sessionRepo.create({
      title: args.title,
      source: args.source,
    });

    this.currentSessionId = session.id;
    const chunkSeconds = this.settingsRepo.get<number>('chunk_seconds', 10);
    const micDeviceId  = this.settingsRepo.get<number | null>('mic_device_id', null) ?? -1;

    if (args.source === 'mic' || args.source === 'both') {
      this.micRecorder.start(session.id, micDeviceId, chunkSeconds);
    }

    if (args.source === 'system' || args.source === 'both') {
      this.loopbackRecorder.start();
    }

    this.state = 'recording';
    this.sessionStartTime = Date.now();
    this.startSleepWatchdog();

    logger.info({ event: 'session_started', sessionId: session.id });
    notify(this.win, PUSH_CHANNELS.SESSION_STATUS_CHANGED, {
      sessionId: session.id,
      newStatus: 'recording' as SessionStatus,
    });

    return { sessionId: session.id };
  }

  pause(): void {
    if (this.state !== 'recording') return;

    this.micRecorder.pause();
    this.state = 'paused';
    this.sessionRepo.updateStatus(this.currentSessionId!, 'paused');

    // Arm 4-hour auto-stop timer
    this.autoStopTimer = setTimeout(() => {
      this.autoStop('pause-timeout');
    }, FOUR_HOURS_MS);

    notify(this.win, PUSH_CHANNELS.SESSION_STATUS_CHANGED, {
      sessionId: this.currentSessionId!,
      newStatus: 'paused' as SessionStatus,
    });

    logger.info({ event: 'session_paused', sessionId: this.currentSessionId });
  }

  resume(): void {
    if (this.state !== 'paused') return;

    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    const chunkSeconds = this.settingsRepo.get<number>('chunk_seconds', 10);
    const micDeviceId  = this.settingsRepo.get<number | null>('mic_device_id', null) ?? -1;
    const session = this.sessionRepo.findById(this.currentSessionId!);
    if (!session) return;

    if (session.source === 'mic' || session.source === 'both') {
      if (!this.micRecorder.isActive()) {
        this.micRecorder.start(session.id, micDeviceId, chunkSeconds);
      }
    }

    this.state = 'recording';
    this.sessionRepo.updateStatus(this.currentSessionId!, 'recording');

    notify(this.win, PUSH_CHANNELS.SESSION_STATUS_CHANGED, {
      sessionId: this.currentSessionId!,
      newStatus: 'recording' as SessionStatus,
    });

    logger.info({ event: 'session_resumed', sessionId: this.currentSessionId });
  }

  stop(): void {
    if (this.state === 'idle') return;

    this.micRecorder.stop();
    this.loopbackRecorder.stop();
    this.clearTimers();

    const now = new Date().toISOString();
    const durationSeconds = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    if (this.currentSessionId) {
      this.sessionRepo.updateEndTime(this.currentSessionId, now, durationSeconds);
      this.sessionRepo.updateStatus(this.currentSessionId, 'processing');

      notify(this.win, PUSH_CHANNELS.SESSION_STATUS_CHANGED, {
        sessionId: this.currentSessionId,
        newStatus: 'processing' as SessionStatus,
      });
    }

    this.state = 'processing';
    logger.info({ event: 'session_stopped', sessionId: this.currentSessionId, durationSeconds });
  }

  private autoStop(reason: 'sleep' | 'pause-timeout'): void {
    if (this.state === 'idle') return;
    this.stop();
    if (this.currentSessionId) {
      notify(this.win, PUSH_CHANNELS.SESSION_AUTO_STOPPED, {
        sessionId: this.currentSessionId,
        reason,
      });
    }
    this.state = 'idle';
    this.currentSessionId = null;
  }

  private startSleepWatchdog(): void {
    let lastCheck = Date.now();
    this.sleepWatchdog = setInterval(() => {
      const now = Date.now();
      const gap = now - lastCheck;
      if (gap > SLEEP_THRESHOLD_MS && this.state === 'recording') {
        logger.warn({ event: 'sleep_detected', gapMs: gap });
        this.autoStop('sleep');
      }
      lastCheck = now;
    }, 5_000);
  }

  private clearTimers(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (this.sleepWatchdog) {
      clearInterval(this.sleepWatchdog);
      this.sleepWatchdog = null;
    }
  }

  cleanup(): void {
    this.clearTimers();
    if (this.state === 'recording' || this.state === 'paused') {
      this.micRecorder.stop();
      this.loopbackRecorder.stop();
    }
  }
}

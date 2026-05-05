export type LoopbackEvent =
  | { type: 'vu';    rmsDb: number }
  | { type: 'chunk'; path: string; seq: number; startSeconds: number; endSeconds: number }
  | { type: 'error'; message: string };

export interface StartOptions {
  /** Directory to write WAV chunk files. If omitted: VU-only preview mode (no writes). */
  sessionDir?: string;
  /** Seconds of audio per WAV chunk. Default: 10. Ignored in preview mode. */
  chunkSeconds?: number;
  /** How often to emit VU events (ms). Default: 50. */
  vuIntervalMs?: number;
}

export function start(opts: StartOptions, cb: (e: LoopbackEvent) => void): void;
export function stop(): void;
export function isRunning(): boolean;

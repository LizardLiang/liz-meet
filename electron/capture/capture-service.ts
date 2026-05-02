// electron/capture/capture-service.ts
// Top-level capture service orchestrator.

export { SessionStateMachine } from './session-state.js';
export { MicRecorder } from './mic-recorder.js';
export { LoopbackRecorder } from './loopback-recorder.js';
export { runPreflight } from './preflight.js';
export { detectOrphanedSessions } from './recovery.js';
export { DeviceMonitor } from './device-monitor.js';

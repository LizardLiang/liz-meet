// src/lib/ipc.ts
// Typed IPC invoke wrapper for the renderer process.

export class IpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly logId?: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/**
 * Invoke an IPC channel and unwrap the result envelope.
 * Throws IpcError if the result is { ok: false, ... }.
 */
export async function invokeIpc<T>(
  channel: string,
  payload?: unknown,
): Promise<T> {
  const result = await window.ipcRenderer.invoke(channel, payload);
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok) return (result as { ok: true; data: T }).data;
    const err = (result as { ok: false; error: { code: string; message: string; logId?: string } }).error;
    throw new IpcError(err.code, err.message, err.logId);
  }
  return result as T;
}

/** Subscribe to a push channel from main process. Returns an unsubscribe function. */
export function onPush<T>(
  channel: string,
  handler: (payload: T) => void,
): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload);
  window.ipcRenderer.on(channel, listener);
  return () => window.ipcRenderer.off(channel, listener);
}

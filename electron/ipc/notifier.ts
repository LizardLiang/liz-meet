// electron/ipc/notifier.ts
// Safe wrapper for win.webContents.send — checks window is not destroyed.

import type { BrowserWindow } from 'electron';

export function notify(win: BrowserWindow, channel: string, payload: unknown): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

// electron/db/settings-repository.ts
// Key/value store for app settings with typed defaults.

import type Database from 'better-sqlite3';
import { DEFAULT_SETTINGS } from '../../src/types/liz-transcribe.js';

const DEFAULT_MAP: Record<string, unknown> = {
  chunk_seconds: DEFAULT_SETTINGS.chunkSeconds,
  mic_device_id: DEFAULT_SETTINGS.micDeviceId,
  provider: DEFAULT_SETTINGS.provider,
  keep_raw_audio: DEFAULT_SETTINGS.keepRawAudio,
  telemetry_opt_in: DEFAULT_SETTINGS.telemetryOptIn,
};

export class SettingsRepository {
  constructor(private db: Database.Database) {}

  get<T>(key: string, defaultValue?: T): T {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;

    if (!row) {
      // Return known defaults
      if (key in DEFAULT_MAP) return DEFAULT_MAP[key] as T;
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Settings key '${key}' not found and no default provided`);
    }

    return JSON.parse(row.value) as T;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  getAll(): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value FROM settings')
      .all() as Array<{ key: string; value: string }>;

    const result: Record<string, unknown> = { ...DEFAULT_MAP };
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value);
    }
    return result;
  }
}

// electron/db/database.ts
// better-sqlite3 connection with WAL mode + migration runner.

import BetterSqlite3 from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { runMigrations } from './migration-runner.js';

let _db: BetterSqlite3.Database | null = null;

export function getDatabase(): BetterSqlite3.Database {
  if (_db) return _db;

  const userData = app.getPath('userData');
  if (!existsSync(userData)) mkdirSync(userData, { recursive: true });

  const dbPath = path.join(userData, 'liz-transcribe.db');
  _db = new BetterSqlite3(dbPath);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  // Apply pending migrations
  runMigrations(_db);

  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export type { BetterSqlite3 };

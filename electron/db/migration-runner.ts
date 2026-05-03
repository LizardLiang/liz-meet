// electron/db/migration-runner.ts
// Simple sequential migration runner. Reads SQL files from the migrations/
// directory and applies any that haven't been applied yet.

import type Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev, migrations live in the source tree. In packaged builds they are
// copied alongside the bundle under dist-electron/migrations/.
const MIGRATIONS_DIR = process.env['APP_ROOT']
  ? path.join(process.env['APP_ROOT'], 'electron', 'db', 'migrations')
  : path.join(__dirname, 'migrations');

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists so we can query it safely
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = (
    db.prepare('SELECT MAX(version) as v FROM schema_version').get() as
      | { v: number | null }
      | undefined
  )?.v ?? 0;

  // Collect migration files: NNN_*.sql sorted ascending
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (version <= currentVersion) continue;

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    // Execute the migration SQL directly (DDL cannot run inside a transaction in SQLite via exec)
    db.exec(sql);
  }
}

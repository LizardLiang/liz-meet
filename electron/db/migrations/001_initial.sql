-- 001_initial.sql
-- Initial schema for liz-transcribe feature

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  started_at              TEXT,
  ended_at                TEXT,
  duration_seconds        INTEGER,
  status                  TEXT NOT NULL CHECK (status IN
                            ('recording','paused','processing',
                             'completed','completed_with_failures','failed')),
  speaker_count           INTEGER,
  source                  TEXT NOT NULL CHECK (source IN ('mic','system','both')),
  provider                TEXT NOT NULL DEFAULT 'assemblyai',
  raw_audio_path          TEXT,
  notice_hash_at_creation TEXT
);

CREATE INDEX idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);

CREATE TABLE chunks (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stream        TEXT NOT NULL CHECK (stream IN ('mic','system')),
  seq           INTEGER NOT NULL,
  file_path     TEXT NOT NULL,
  start_seconds REAL NOT NULL,
  end_seconds   REAL NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('pending','uploading','polling','transcribed',
                   'failed','permanently_failed')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  upload_url    TEXT,
  transcript_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_chunks_session_stream_seq
  ON chunks(session_id, stream, seq);
CREATE INDEX idx_chunks_status ON chunks(status);
CREATE INDEX idx_chunks_session ON chunks(session_id);

CREATE TABLE segments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_id            TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  stream              TEXT NOT NULL CHECK (stream IN ('mic','system')),
  speaker_label       TEXT NOT NULL,
  start_seconds       REAL NOT NULL,
  end_seconds         REAL NOT NULL,
  text                TEXT NOT NULL,
  confidence          REAL,
  is_failed_placeholder INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_segments_session_start ON segments(session_id, start_seconds);

-- FTS5 virtual table mirrors segments.text
CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers keep FTS5 in sync with segments
CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
END;

CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE speaker_label_overrides (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_label  TEXT NOT NULL,
  custom_label    TEXT NOT NULL,
  PRIMARY KEY (session_id, original_label)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed default settings
INSERT INTO schema_version(version) VALUES (1);

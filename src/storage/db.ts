import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    diarized_at TEXT,
    language_codes TEXT,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    is_final INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_segments_session ON transcript_segments(session_id);

  CREATE TABLE IF NOT EXISTS summaries (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    overview TEXT NOT NULL,
    key_decisions TEXT NOT NULL,
    discussion_topics TEXT NOT NULL,
    next_steps TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    model_used TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    owner TEXT,
    description TEXT NOT NULL,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    confidence TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_action_items_session ON action_items(session_id);

  CREATE TABLE IF NOT EXISTS sentiment_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    score REAL NOT NULL,
    magnitude REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sentiment_session ON sentiment_scores(session_id);

  CREATE TABLE IF NOT EXISTS triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    category TEXT NOT NULL,
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    segment_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_triggers_session ON triggers(session_id);

  CREATE TABLE IF NOT EXISTS corpus_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    embedding TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_corpus_session ON corpus_chunks(session_id);

  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    trigger_id INTEGER REFERENCES triggers(id),
    trigger_category TEXT NOT NULL,
    suggestion_text TEXT NOT NULL,
    source_citation TEXT,
    confidence REAL NOT NULL,
    user_action TEXT NOT NULL DEFAULT 'ignored',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_suggestions_session ON suggestions(session_id);

  CREATE TABLE IF NOT EXISTS fact_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    trigger_id INTEGER REFERENCES triggers(id),
    claim_text TEXT NOT NULL,
    source_queried TEXT NOT NULL,
    ground_truth TEXT,
    result TEXT NOT NULL,
    surfaced INTEGER NOT NULL DEFAULT 0,
    user_action TEXT NOT NULL DEFAULT 'ignored',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_fact_checks_session ON fact_checks(session_id);

  CREATE TABLE IF NOT EXISTS live_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    question_text TEXT NOT NULL,
    answer_text TEXT,
    sources_used TEXT,
    asked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_live_queries_session ON live_queries(session_id);

  -- Improvements Phase §2: persistent meeting-state layer (rolling summary +
  -- open-items registry), one row per session, updated incrementally as the
  -- meeting progresses rather than recomputed from the full transcript each
  -- time. last_updated_segment_count tracks progress as a plain count rather
  -- than a segment FK — TranscriptSegment has no stable id in this codebase's
  -- domain layer (only the DB row does), so a count is the simpler match.
  CREATE TABLE IF NOT EXISTS meeting_state (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    rolling_summary TEXT NOT NULL DEFAULT '',
    open_items TEXT NOT NULL DEFAULT '[]',
    last_updated_segment_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

`);

// Voice-emotion (Imentiv AI) support was removed — drop the table for anyone
// who had it created by a previous version rather than leaving an orphaned
// table behind.
db.exec('DROP TABLE IF EXISTS voice_emotion_scores');

const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
for (const column of ['diarized_at', 'language_codes', 'name']) {
  if (!sessionColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
  }
}

const triggerColumns = db.prepare('PRAGMA table_info(triggers)').all() as { name: string }[];
if (!triggerColumns.some((c) => c.name === 'segment_text')) {
  db.exec('ALTER TABLE triggers ADD COLUMN segment_text TEXT');
}

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

  -- Holds only the LATEST in-progress (non-final) result per speaker per
  -- session — overwritten in place, not appended to. Recovery-only: lets a
  -- crash mid-utterance (process killed before Google ever sends a final
  -- result) be recovered as a best-effort final segment at the next
  -- startup instead of silently losing whatever was being said. Cleared the
  -- moment a real final segment supersedes it, and on a normal session
  -- stop — see closeOrphanedSessions()/segmentRepository.ts.
  CREATE TABLE IF NOT EXISTS interim_segments (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, speaker)
  );

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

  -- Tracks a background Claude Code CLI run ("Implement with Claude Code")
  -- for a specific action item — see src/integrations/claudeCodeCli.ts.
  -- diff is captured once at 'ready' time and reused for the later approve
  -- step, so approval still works even after the worktree itself is cleaned
  -- up. status: 'running' | 'ready' | 'applied' | 'pushed' | 'discarded' | 'failed'.
  CREATE TABLE IF NOT EXISTS code_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_item_id INTEGER NOT NULL REFERENCES action_items(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    repo_name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    cli_session_id TEXT NOT NULL,
    worktree_path TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    diff TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_code_change_requests_action_item ON code_change_requests(action_item_id);

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

  -- Pre-meeting prep: one row per prepared session, holding the synthesized
  -- brief plus enough raw context for traceability/debugging. sources_queried
  -- and raw_context are JSON-encoded strings (same convention as
  -- sessions.language_codes) rather than normalized tables, since this data
  -- is written once by PrepService and only ever read back whole.
  CREATE TABLE IF NOT EXISTS prep_briefs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
    meeting_type TEXT NOT NULL,
    calendar_event_id TEXT,
    sources_queried TEXT NOT NULL,
    prep_brief_text TEXT NOT NULL,
    raw_context TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );

  -- Local codebase index for design/dev prep (src/codebase/) — same shape as
  -- corpus_chunks, but not session-scoped: one repo can be re-indexed anytime
  -- (deleteChunksForRepo + reinsert), independent of any meeting.
  CREATE TABLE IF NOT EXISTS code_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_code_chunks_repo ON code_chunks(repo_name);

  -- Settings-page overrides for config.ts's dynamic fields. Presence of a key
  -- here wins over its .env value; absence falls back to .env/default (see
  -- config.ts's str/num/bool helpers). Plaintext, same risk profile as .env.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Raw ingestion target for a separate, external daily-indexing task (e.g. a
  -- Claude Desktop agent with Microsoft 365 access) — Speako never writes
  -- here except to set indexed_at once a row's been chunked+embedded. The
  -- external task owns inserts/upserts; see docs/EXTERNAL_INGESTION_PROMPT.md.
  CREATE TABLE IF NOT EXISTS external_messages (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT,
    participants TEXT,
    occurred_at TEXT NOT NULL,
    body_text TEXT NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    indexed_at TEXT
  );

  -- Speako's own chunked+embedded index of external_messages — same shape as code_chunks.
  CREATE TABLE IF NOT EXISTS external_message_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES external_messages(id),
    source TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_external_message_chunks_source ON external_message_chunks(source);

  -- On-demand post-session conversational-skill coaching (talk-time ratio,
  -- filler-word count, and qualitative feedback) — same on-demand shape as
  -- summaries: computed once via POST /api/sessions/:id/coach, not automatic.
  CREATE TABLE IF NOT EXISTS coaching_feedback (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    talk_time_ratio REAL NOT NULL,
    filler_word_count INTEGER NOT NULL,
    filler_word_examples TEXT NOT NULL,
    feedback_points TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );

  -- Running daily token-usage totals per Gemini call site (feature), so the
  -- cost-optimization work (model tiering, thinking-disable, caching) has a
  -- visible before/after instead of relying on the plan's assumptions.
  CREATE TABLE IF NOT EXISTS gemini_usage (
    feature TEXT NOT NULL,
    date TEXT NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    thinking_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (feature, date)
  );

  -- On-demand meeting chapters (timestamped topic breakpoints) — same
  -- compute-once-cache-in-a-row shape as coaching_feedback/summaries, one
  -- Gemini call per session via POST /api/sessions/:id/chapters.
  CREATE TABLE IF NOT EXISTS meeting_chapters (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    chapters TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );

  -- "Ask across all my meetings" — not session-scoped (deliberately, unlike
  -- live_queries), so no FK to sessions and no cleanup needed on session delete.
  CREATE TABLE IF NOT EXISTS cross_session_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_text TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    sources_used TEXT NOT NULL,
    asked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

`);

// Voice-emotion (Imentiv AI) support was removed — drop the table for anyone
// who had it created by a previous version rather than leaving an orphaned
// table behind.
db.exec('DROP TABLE IF EXISTS voice_emotion_scores');

const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
for (const column of ['diarized_at', 'language_codes', 'name', 'meeting_type', 'calendar_event_id', 'active_tools', 'scheduled_start_at', 'active_features', 'scheduled_end_at', 'calendar_meeting_info']) {
  if (!sessionColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
  }
}
if (!sessionColumns.some((c) => c.name === 'session_type')) {
  // 'work' default matches createSession()'s own default (segmentRepository.ts)
  // now that Speako is work-only — this column-level default only matters
  // for a raw INSERT that omits the column outright, which the app itself
  // never does (createSession always supplies it explicitly).
  db.exec("ALTER TABLE sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'work'");
}
if (!sessionColumns.some((c) => c.name === 'prep_status')) {
  db.exec("ALTER TABLE sessions ADD COLUMN prep_status TEXT NOT NULL DEFAULT 'none'");
}
if (!sessionColumns.some((c) => c.name === 'session_kind')) {
  // Orthogonal to session_type (personal/work, meetings only) — distinguishes
  // real recorded meetings from voice-chat/practice sessions for the sidebar
  // history tabs. Backfills existing practice sessions using the only signal
  // that existed before this column: the "Practice: " name prefix
  // (src/interface/server.ts's startVoiceSession) — a one-time best-effort
  // recovery, not a permanent identification mechanism going forward.
  db.exec("ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'meeting'");
  db.exec("UPDATE sessions SET session_kind = 'practice' WHERE name LIKE 'Practice: %'");
}

// Indexed here (after the ALTER TABLEs above, since these columns don't exist
// on a fresh CREATE TABLE) — findLikelyPreviousSession filters on
// session_type+meeting_type, and getDueScheduledSessions filters on
// scheduled_start_at from a 20s poller, both previously full-scanning sessions.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_type_meeting ON sessions(session_type, meeting_type);
  CREATE INDEX IF NOT EXISTS idx_sessions_scheduled_start ON sessions(scheduled_start_at) WHERE scheduled_start_at IS NOT NULL;
`);

const triggerColumns = db.prepare('PRAGMA table_info(triggers)').all() as { name: string }[];
if (!triggerColumns.some((c) => c.name === 'segment_text')) {
  db.exec('ALTER TABLE triggers ADD COLUMN segment_text TEXT');
}

const prepBriefColumns = db.prepare('PRAGMA table_info(prep_briefs)').all() as { name: string }[];
if (!prepBriefColumns.some((c) => c.name === 'anticipated_qa')) {
  db.exec('ALTER TABLE prep_briefs ADD COLUMN anticipated_qa TEXT');
}

const coachingColumns = db.prepare('PRAGMA table_info(coaching_feedback)').all() as { name: string }[];
for (const column of ['you_interrupted_others_count', 'others_interrupted_you_count']) {
  if (!coachingColumns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE coaching_feedback ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}

const summaryColumns = db.prepare('PRAGMA table_info(summaries)').all() as { name: string }[];
if (!summaryColumns.some((c) => c.name === 'topics')) {
  db.exec("ALTER TABLE summaries ADD COLUMN topics TEXT NOT NULL DEFAULT '[]'");
}

const actionItemColumns = db.prepare('PRAGMA table_info(action_items)').all() as { name: string }[];
if (!actionItemColumns.some((c) => c.name === 'type')) {
  // Every action item created before this migration is a plain follow-up
  // note — 'general' is the honest default, not a guess at what it "really"
  // was. Existing rows whose description already reads as a code change
  // (the only type with a pre-existing specialized flow, "Implement with
  // Claude Code") are left as 'general' too — backfilling a guess from free
  // text isn't worth the false positives it'd create.
  db.exec("ALTER TABLE action_items ADD COLUMN type TEXT NOT NULL DEFAULT 'general'");
}
if (!actionItemColumns.some((c) => c.name === 'reminder_notified_at')) {
  // Set once a 'reminder'-type item's due-time notification has actually
  // been broadcast — checked server-side on a timer (see
  // InterfaceServer.checkReminders()) instead of a client-side setTimeout,
  // which overflowed for anything >~24.8 days out (setTimeout's delay is a
  // 32-bit signed int) and lost the pending reminder outright on any page
  // refresh with no way to re-arm it.
  db.exec('ALTER TABLE action_items ADD COLUMN reminder_notified_at TEXT');
}
if (!actionItemColumns.some((c) => c.name === 'external_ref')) {
  // JSON: { tool: 'jira'|'confluence', action: 'created'|'updated', key, url, at }
  // — set once a jira/confluence action item's real create/update actually
  // succeeds, so the UI can show the resulting issue/page link and the user
  // isn't left wondering whether clicking the button did anything.
  db.exec('ALTER TABLE action_items ADD COLUMN external_ref TEXT');
}

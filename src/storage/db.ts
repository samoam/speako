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
  -- action_item_id/session_id are nullable (not just optional in the type)
  -- because a Jira-Dashboard-card-originated request has neither — see
  -- task_id below. Exactly one of action_item_id/task_id is set per row,
  -- enforced in application code, not a DB constraint, matching this
  -- codebase's existing lightweight-constraint style elsewhere.
  CREATE TABLE IF NOT EXISTS code_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_item_id INTEGER REFERENCES action_items(id),
    task_id INTEGER REFERENCES tasks(id),
    session_id TEXT REFERENCES sessions(id),
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

  -- One row per PR-review run ("Review PR" on a Bitbucket Dashboard card) —
  -- see src/summarization/prReviewContext.ts + the /api/plate/:id/review
  -- route. Simpler lifecycle than code_change_requests above: no applied/
  -- pushed stages, and no cli_session_id/worktree_path to persist across a
  -- restart, since the whole run is one awaited claude -p call server-side
  -- (see claudeCodeCli.ts's runClaudeCodeReview), not a detached background
  -- agent. status: 'running' | 'ready' | 'failed'.
  CREATE TABLE IF NOT EXISTS pr_review_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    repo_name TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    context TEXT,
    review TEXT,
    error TEXT,
    log TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pr_review_requests_task ON pr_review_requests(task_id);

  CREATE INDEX IF NOT EXISTS idx_code_change_requests_action_item ON code_change_requests(action_item_id);
  -- idx_code_change_requests_task is created further below, after the
  -- guarded rebuild migration — not here, since this statement would run
  -- unconditionally even against a pre-existing DB whose code_change_requests
  -- table doesn't have task_id yet (CREATE TABLE IF NOT EXISTS above is a
  -- no-op for it, but this CREATE INDEX isn't conditional on that).

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

  -- session_id is nullable: set only for "audio overview of this specific
  -- session" (its own summary as the grounding source); null for a
  -- subject-driven overview grounded across the whole meeting corpus via
  -- RAG (see src/qa/crossSessionQa.ts's identical scoping). Session-linked
  -- rows get cleaned up (row + audio file) by deleteSession(); subject-
  -- driven rows persist independently, like cross_session_queries above.
  CREATE TABLE IF NOT EXISTS audio_overviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    subject_text TEXT NOT NULL,
    script_text TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audio_overviews_session ON audio_overviews(session_id);

  -- The "My Plate" orchestrator's unified cross-source task board — one row
  -- per actionable item (a Jira issue assigned to you, a Bitbucket PR
  -- awaiting your review, an open cross-session action item), deduped by
  -- (source, external_ref) so re-syncing the same still-open item is an
  -- idempotent upsert rather than a duplicate row. Deliberately no FK to
  -- sessions — an action-item-sourced task references a session via
  -- external_ref/url only, and outlives that reference the same way
  -- cross_session_queries above has no FK either.
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    url TEXT,
    due_date TEXT,
    urgency_score INTEGER NOT NULL,
    importance_score INTEGER NOT NULL,
    priority_score INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source, external_ref);

  -- One row per calendar day (server's local date, YYYY-MM-DD) — the morning
  -- digest (src/summarization/morningBriefing.ts), generated at most once per
  -- day by server.ts's checkMorningBriefing() so re-ticking the same 20s
  -- scheduleTimer loop it hooks into doesn't regenerate it repeatedly.
  CREATE TABLE IF NOT EXISTS daily_briefings (
    date TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per Teams message the AI triage pass (src/communications/
  -- teamsMessageTriage.ts) has already classified — stores classification
  -- results only (directed_at_me, summary, an optional draft reply), never
  -- priority scores, since urgency/importance are recomputed live from raw
  -- facts (message recency, directed_at_me) on every taskSync.ts pass, same
  -- as every other tasks source.
  CREATE TABLE IF NOT EXISTS teams_message_triage (
    message_id TEXT PRIMARY KEY REFERENCES external_messages(id),
    directed_at_me INTEGER NOT NULL,
    summary TEXT NOT NULL,
    draft_reply TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Same idea as teams_message_triage above, but for inbox email — no
  -- "directed at me" question needed here (the whole inbox is already the
  -- user's own), so this asks whether the message needs a reply instead.
  CREATE TABLE IF NOT EXISTS email_message_triage (
    message_id TEXT PRIMARY KEY REFERENCES external_messages(id),
    needs_reply INTEGER NOT NULL,
    summary TEXT NOT NULL,
    draft_reply TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Generic human-approval gate for every external write Speako makes
  -- (Teams/email replies, Jira comments/transitions, Confluence pages,
  -- Bitbucket PR comments, PR opens, code changes, Jenkins fixes/rebuilds).
  -- Deliberately ADDITIVE, not a migration of code_change_requests/
  -- pr_review_requests/tasks.draft_reply into one table: those keep their own
  -- status columns as the *execution record* for their kind, while this table
  -- is the *human gate* sitting in front of them — a per-kind adapter maps
  -- between the two (see src/drafts/). Each write-surface migrates onto this
  -- table on its own schedule; un-migrated surfaces keep working untouched.
  -- status: 'generating'|'ready'|'refining'|'executing'|'completed'|'failed'|'discarded'.
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'generating',
    stage INTEGER NOT NULL DEFAULT 0,
    content TEXT,
    result_ref TEXT,
    error TEXT,
    redo_of_draft_id INTEGER REFERENCES drafts(id),
    superseded_by_draft_id INTEGER REFERENCES drafts(id),
    execution_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_drafts_subject ON drafts(subject_kind, subject_id, kind, id DESC);

  -- The refinement conversation for a draft — one row per turn, append-only.
  -- role: 'user'|'assistant'. kind: 'instruction'|'draft'|'answer'|'manual_edit'|'note'.
  -- content is capped (see draftRepository.ts's MAX_REVISION_CONTENT_BYTES) so
  -- a large payload (e.g. a code diff) isn't re-snapshotted on every refine turn.
  CREATE TABLE IF NOT EXISTS draft_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id),
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_draft_revisions_draft ON draft_revisions(draft_id, turn);

  -- One row per ticket-driven development cycle (Jira -> branch -> plan ->
  -- implement -> pre-PR check -> PR -> QA Ready), the spine the dev-cycle
  -- engine (src/dev/) hangs everything else off of. Only one active cycle per
  -- ticket at a time (see the unique index below) — a Return loop reuses the
  -- same row/branch rather than creating a new one.
  CREATE TABLE IF NOT EXISTS dev_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_key TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    repo_name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    branch_type TEXT NOT NULL,
    branch_name TEXT,
    base_branch TEXT NOT NULL DEFAULT 'main',
    worktree_path TEXT,
    lifecycle_state TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    pr_project_key TEXT,
    pr_repo_slug TEXT,
    pr_id INTEGER,
    pr_url TEXT,
    jenkins_job_path TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_cycles_ticket_active ON dev_cycles(ticket_key) WHERE status = 'active';

  -- Plan-before-code: one row per plan attempt for a dev cycle. Refinement
  -- supersedes with a new row (status 'superseded') rather than mutating in
  -- place, so the history of what was proposed/rejected is never lost.
  -- status: 'running'|'ready'|'approved'|'rejected'|'superseded'|'failed'.
  CREATE TABLE IF NOT EXISTS dev_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_cycle_id INTEGER NOT NULL REFERENCES dev_cycles(id),
    round INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'running',
    plan TEXT,
    seed_context TEXT,
    feedback TEXT,
    log TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_dev_plans_cycle ON dev_plans(dev_cycle_id);

  -- Jenkins builds Speako has observed, one row per (job_path, build_number)
  -- so re-polling an already-seen build is an idempotent upsert. dev_cycle_id
  -- is nullable — a build for a branch under review (not owned by a dev
  -- cycle) is still tracked here for reporting, just without that FK.
  CREATE TABLE IF NOT EXISTS jenkins_builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_cycle_id INTEGER REFERENCES dev_cycles(id),
    job_path TEXT NOT NULL,
    branch_name TEXT,
    build_number INTEGER NOT NULL,
    result TEXT,
    building INTEGER NOT NULL DEFAULT 0,
    url TEXT,
    started_at TEXT,
    classification TEXT,
    classification_json TEXT,
    log_excerpt TEXT,
    notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_jenkins_builds_job_number ON jenkins_builds(job_path, build_number);

`);

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
if (!taskColumns.some((c) => c.name === 'draft_reply')) {
  // Generic enough for other sources later, but only teams_message rows
  // populate it today (see syncTeamsMessages() in taskSync.ts).
  db.exec('ALTER TABLE tasks ADD COLUMN draft_reply TEXT');
}
if (!taskColumns.some((c) => c.name === 'board_status')) {
  // The Dashboard's kanban column for this task ('todo'|'in_progress'|'done')
  // — orthogonal to `status` (open/dismissed, which removes a task from view
  // entirely). Never touched by taskRepository.ts's upsert ON CONFLICT, same
  // as `status` isn't — otherwise a re-sync would snap a dragged card back
  // to "To Do".
  db.exec("ALTER TABLE tasks ADD COLUMN board_status TEXT NOT NULL DEFAULT 'todo'");
}
if (!taskColumns.some((c) => c.name === 'code_review')) {
  // AI-generated Bitbucket PR review notes (src/summarization/codeReviewDrafts.ts)
  // — kept separate from draft_reply, which means "a drafted chat/email
  // reply"; overloading it for code-review text would blur two different
  // concepts for future readers.
  db.exec('ALTER TABLE tasks ADD COLUMN code_review TEXT');
}

const prReviewRequestColumns = db.prepare('PRAGMA table_info(pr_review_requests)').all() as { name: string }[];
if (!prReviewRequestColumns.some((c) => c.name === 'log')) {
  // Live progress lines (src/storage/prReviewRequestRepository.ts's
  // appendPrReviewLog) — added after this table's initial CREATE TABLE
  // already shipped in a real DB this session, hence the guarded ALTER
  // rather than just adding the column to the CREATE TABLE above.
  db.exec('ALTER TABLE pr_review_requests ADD COLUMN log TEXT');
}

// code_change_requests originally only supported the meeting-action-item
// origin (action_item_id/session_id both NOT NULL). Extending "Implement
// with Claude Code" to Jira Dashboard cards (which have neither an action
// item nor a session) needs those relaxed to nullable, plus a new nullable
// task_id — SQLite can't ALTER a column's NOT NULL/FK directly, so this is
// the standard rename-rebuild-copy-drop idiom, guarded to run once via the
// notnull flag on the existing column.
const codeChangeRequestColumns = db.prepare('PRAGMA table_info(code_change_requests)').all() as { name: string; notnull: number }[];
const actionItemIdColumn = codeChangeRequestColumns.find((c) => c.name === 'action_item_id');
if (actionItemIdColumn && actionItemIdColumn.notnull) {
  db.exec(`
    ALTER TABLE code_change_requests RENAME TO code_change_requests_old;

    CREATE TABLE code_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_item_id INTEGER REFERENCES action_items(id),
      task_id INTEGER REFERENCES tasks(id),
      session_id TEXT REFERENCES sessions(id),
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

    INSERT INTO code_change_requests (id, action_item_id, task_id, session_id, repo_name, repo_path, cli_session_id, worktree_path, status, diff, error, created_at, resolved_at)
    SELECT id, action_item_id, NULL, session_id, repo_name, repo_path, cli_session_id, worktree_path, status, diff, error, created_at, resolved_at
    FROM code_change_requests_old;

    DROP TABLE code_change_requests_old;

    CREATE INDEX IF NOT EXISTS idx_code_change_requests_action_item ON code_change_requests(action_item_id);
  `);
}
// Safe unconditionally at this point — the column exists either way (a
// fresh DB got it straight from the main CREATE TABLE above; a pre-existing
// one just got it from the rebuild migration).
db.exec('CREATE INDEX IF NOT EXISTS idx_code_change_requests_task ON code_change_requests(task_id)');

// Extends code_change_requests to also serve dev-cycle-originated runs (a
// ticket's plan-before-code implementation, or a Jenkins-fix dispatch).
// repo_path for such a row is set to the dev cycle's OWN long-lived branch
// worktree (dev_cycles.worktree_path) rather than the plain configured repo
// path — confirmed live that `claude --bg` may or may not create a further
// nested worktree of its own depending on whether its cwd is already a
// linked worktree (inconsistent across runs, not something to rely on
// either way); pollCodeChangeRequest()/getWorktreeDiff() already resolve the
// *agent's actual* cwd via `getTaskInfo()` regardless, and applyCodeChangeToRepo/
// pushRepoChanges already target whatever `repo_path` a row was created
// with — so routing a dev-cycle row's repo_path to the cycle's worktree is
// the only change needed; no new CLI plumbing. The one real trap this
// creates: if the agent did NOT nest, its reported cwd IS the cycle's own
// worktree, so discard must never blindly `git worktree remove` it (see
// server.ts's dev-cycle-aware discard handling).
const codeChangeRequestColumns2 = db.prepare('PRAGMA table_info(code_change_requests)').all() as { name: string }[];
if (!codeChangeRequestColumns2.some((c) => c.name === 'dev_cycle_id')) {
  db.exec('ALTER TABLE code_change_requests ADD COLUMN dev_cycle_id INTEGER REFERENCES dev_cycles(id)');
}
if (!codeChangeRequestColumns2.some((c) => c.name === 'origin')) {
  db.exec("ALTER TABLE code_change_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'action_item'");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_code_change_requests_dev_cycle ON code_change_requests(dev_cycle_id)');

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

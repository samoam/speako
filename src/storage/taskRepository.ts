import { db } from './db';

export type TaskSource = 'jira' | 'bitbucket_pr' | 'action_item' | 'teams_message' | 'email_message' | 'jenkins_build';
export type TaskStatus = 'open' | 'dismissed';
export type TaskBoardStatus = 'todo' | 'in_progress' | 'on_hold' | 'done';

export interface Task {
  id: number;
  source: TaskSource;
  externalRef: string;
  title: string;
  description: string | null;
  url: string | null;
  dueDate: string | null;
  urgencyScore: number;
  importanceScore: number;
  priorityScore: number;
  draftReply: string | null;
  status: TaskStatus;
  boardStatus: TaskBoardStatus;
  snoozedUntil: string | null;
  priorityOverride: number | null;
  dueDateIsManual: boolean;
  manuallyAdded: boolean;
  myReviewStatus: string | null;
  urgencySignal: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTaskInput {
  source: TaskSource;
  externalRef: string;
  title: string;
  description?: string | null;
  url?: string | null;
  dueDate?: string | null;
  urgencyScore: number;
  importanceScore: number;
  draftReply?: string | null;
  /** True for a task added via addManualTask() (a Jira key/Bitbucket PR ref typed in directly) rather than discovered by the automatic sync. Sticky once set — see upsertStmt's CASE guard below. */
  manuallyAdded?: boolean;
  /** bitbucket_pr review tasks only — taskSync.ts's deriveReviewState (NEW/NEEDS_WORK/REWORKED). */
  myReviewStatus?: string | null;
  /** Comment mentions only — first non-null value sticks (see upsertStmt). */
  urgencySignal?: string | null;
}

function mapRow(r: any): Task {
  return {
    id: r.id,
    source: r.source,
    externalRef: r.external_ref,
    title: r.title,
    description: r.description,
    url: r.url,
    dueDate: r.due_date,
    urgencyScore: r.urgency_score,
    importanceScore: r.importance_score,
    priorityScore: r.priority_score,
    draftReply: r.draft_reply,
    status: r.status,
    boardStatus: r.board_status,
    snoozedUntil: r.snoozed_until,
    priorityOverride: r.priority_override,
    dueDateIsManual: !!r.due_date_is_manual,
    manuallyAdded: !!r.manually_added,
    myReviewStatus: r.my_review_status ?? null,
    urgencySignal: r.urgency_signal ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const upsertStmt = db.prepare(`
  INSERT INTO tasks (source, external_ref, title, description, url, due_date, urgency_score, importance_score, priority_score, draft_reply, manually_added, my_review_status, urgency_signal)
  VALUES (@source, @externalRef, @title, @description, @url, @dueDate, @urgencyScore, @importanceScore, @priorityScore, @draftReply, @manuallyAdded, @myReviewStatus, @urgencySignal)
  ON CONFLICT(source, external_ref) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    url = excluded.url,
    due_date = CASE
      -- Preserves a manually-set due date (setTaskDueDate) across
      -- resyncs, same "manual state must survive the next upsert"
      -- principle as draft_reply's guard below — otherwise a re-sync of
      -- a source with no due date of its own (Teams/email messages,
      -- Jira/Bitbucket comment mentions) would silently null it back out.
      WHEN due_date_is_manual = 1 THEN due_date
      ELSE excluded.due_date
    END,
    urgency_score = excluded.urgency_score,
    importance_score = excluded.importance_score,
    priority_score = CASE
      -- Same idea for a manual priority override (setTaskPriorityOverride)
      -- — once set, it IS the priority_score until explicitly cleared,
      -- regardless of what a fresh urgency*importance computes to.
      WHEN priority_override IS NOT NULL THEN priority_override
      ELSE excluded.priority_score
    END,
    draft_reply = CASE
      -- Once a teams_reply/email_reply draft exists for this task (the generic
      -- draft gate, src/drafts/), it — not the raw triage re-run — owns the
      -- reply text. Without this, a routine re-sync (every orchestratorPollMinutes)
      -- would silently overwrite a reply the user is mid-refining, or has
      -- already approved/sent, back to whatever the triage pass drafted this
      -- time around. The bare "id" column (unqualified) below is a correlated
      -- reference to THIS existing row, per SQLite's UPSERT semantics.
      WHEN EXISTS (
        SELECT 1 FROM drafts d
        WHERE d.subject_kind = 'task' AND d.subject_id = CAST(id AS TEXT)
          AND d.status NOT IN ('completed', 'discarded', 'failed')
      ) THEN draft_reply
      ELSE excluded.draft_reply
    END,
    -- Sticky like priority_override/due_date_is_manual above: once a task is
    -- flagged manually_added, an ordinary automatic re-sync (which never
    -- passes manuallyAdded: true) must not flip it back to 0 — that flag is
    -- what protects it from pruneTasksForSource() below.
    manually_added = CASE WHEN excluded.manually_added = 1 THEN 1 ELSE manually_added END,
    my_review_status = excluded.my_review_status,
    urgency_signal = COALESCE(urgency_signal, excluded.urgency_signal),
    updated_at = datetime('now')
`);

/**
 * Upserts one task by (source, externalRef) — never touches `status` on an
 * existing row, so a user's dismissal persists across reruns of the same
 * still-open item (only a fresh INSERT gets the table's default 'open').
 */
export function upsertTask(task: UpsertTaskInput): void {
  upsertStmt.run({
    source: task.source,
    externalRef: task.externalRef,
    title: task.title,
    description: task.description ?? null,
    url: task.url ?? null,
    dueDate: task.dueDate ?? null,
    urgencyScore: task.urgencyScore,
    importanceScore: task.importanceScore,
    priorityScore: task.urgencyScore * task.importanceScore,
    draftReply: task.draftReply ?? null,
    manuallyAdded: task.manuallyAdded ? 1 : 0,
    myReviewStatus: task.myReviewStatus ?? null,
    urgencySignal: task.urgencySignal ?? null,
  });
}

/** Records a review decision the moment it's posted from here, rather than leaving the card unchanged until the next Bitbucket sync reads it back. */
export function setTaskMyReviewStatus(id: number, status: string): void {
  db.prepare(`UPDATE tasks SET my_review_status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

/**
 * Excludes snoozed tasks whose snooze hasn't expired yet — the same "not
 * touched by upsert" column as board_status, checked here instead of at
 * write time so a snooze automatically self-clears once its date passes
 * without a separate cron/cleanup job. Both sides go through SQLite's own
 * datetime() rather than a raw string compare — snoozed_until is stored as
 * a JS .toISOString() value ('T'/'Z', milliseconds) while datetime('now')
 * produces "YYYY-MM-DD HH:MM:SS"; comparing those two forms lexicographically
 * is unreliable ('T' sorts after ' ' in ASCII regardless of the actual time
 * represented), same pitfall getTasksCreatedSince's `iso` param already
 * normalizes around.
 */
const SNOOZE_FILTER = `(snoozed_until IS NULL OR datetime(snoozed_until) <= datetime('now'))`;

export function getOpenTasks(): Task[] {
  const rows = db.prepare(`SELECT * FROM tasks WHERE status = 'open' AND ${SNOOZE_FILTER} ORDER BY priority_score DESC`).all() as any[];
  return rows.map(mapRow);
}

/**
 * Open tasks first seen (created_at) at or after `iso` — the "what's
 * genuinely new" input for the morning briefing
 * (src/summarization/morningBriefing.ts). created_at is set once on first
 * INSERT and never touched by a re-sync, unlike updated_at. `iso` is passed
 * through SQLite's own datetime() to normalize it to the same
 * "YYYY-MM-DD HH:MM:SS" form created_at is stored in — comparing a raw
 * ISO 'T'/'Z' string against that form lexicographically is unreliable
 * ('T' > ' ' in ASCII regardless of the actual time represented).
 */
export function getTasksCreatedSince(iso: string): Task[] {
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE status = 'open' AND ${SNOOZE_FILTER} AND created_at >= datetime(?) ORDER BY priority_score DESC`)
    .all(iso) as any[];
  return rows.map(mapRow);
}

export function getTaskById(id: number): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** Looks a task up by its (source, externalRef) — the same pair upsertTask's ON CONFLICT keys on — for callers (e.g. addManualTask) that just upserted and need the resulting row back without knowing its id. */
export function getTaskByExternalRef(source: TaskSource, externalRef: string): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE source = ? AND external_ref = ?').get(source, externalRef) as any;
  return row ? mapRow(row) : undefined;
}

export function dismissTask(id: number): void {
  db.prepare(`UPDATE tasks SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** Reverses dismissTask — the task reappears in getOpenTasks() (assuming it isn't also snoozed) the moment this runs. */
export function undismissTask(id: number): void {
  db.prepare(`UPDATE tasks SET status = 'open', updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** Recently dismissed tasks, for the Dashboard's "Dismissed" tab (undo). Bounded rather than unlimited — a running history of every dismissal ever made isn't useful past a certain point, same reasoning as other recent-only list queries in this codebase. */
export function getDismissedTasks(): Task[] {
  const rows = db.prepare(`SELECT * FROM tasks WHERE status = 'dismissed' ORDER BY updated_at DESC LIMIT 50`).all() as any[];
  return rows.map(mapRow);
}

/** Hides a task from getOpenTasks()/getTasksCreatedSince() until `until` has passed — never touched by upsertTask's ON CONFLICT, same as board_status, so a resync can't silently un-postpone something. */
export function snoozeTask(id: number, until: string): void {
  db.prepare(`UPDATE tasks SET snoozed_until = ?, updated_at = datetime('now') WHERE id = ?`).run(until, id);
}

export function clearSnooze(id: number): void {
  db.prepare(`UPDATE tasks SET snoozed_until = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * Sets/clears a manual priority override. Unlike snoozed_until/board_status,
 * priority_score IS touched by upsertTask's ON CONFLICT (guarded by the
 * CASE on priority_override there) — so besides setting the override
 * itself, this also updates priority_score directly rather than waiting
 * for the next sync pass to pick up the change (override set) or revert to
 * the computed value (override cleared).
 */
export function setTaskPriorityOverride(id: number, override: number | null): void {
  db.prepare(
    `UPDATE tasks
     SET priority_override = ?,
         priority_score = COALESCE(?, urgency_score * importance_score),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(override, override, id);
}

/**
 * Sets/clears a manual due date. Setting due_date_is_manual=1 makes the
 * upsertStmt's CASE guard preserve `dueDate` across future resyncs
 * (necessary for sources like Teams/email messages that have no due date
 * of their own to overwrite it with); clearing it (dueDate: null) reverts
 * to whatever the source itself supplies on the next sync.
 */
export function setTaskDueDate(id: number, dueDate: string | null): void {
  db.prepare(
    `UPDATE tasks SET due_date = ?, due_date_is_manual = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(dueDate, dueDate !== null ? 1 : 0, id);
}

/** Moves a task between kanban columns (Dashboard drag-and-drop) — deliberately not touched by upsertTask's ON CONFLICT, so a re-sync never snaps a dragged card back to 'todo'. */
export function updateTaskBoardStatus(id: number, boardStatus: TaskBoardStatus): void {
  db.prepare(`UPDATE tasks SET board_status = ?, updated_at = datetime('now') WHERE id = ?`).run(boardStatus, id);
}

/** Removes every task for a source not present in `keepExternalRefs` — prunes items that no longer qualify (e.g. a PR merged/closed since the last sync) without re-touching rows that are still current. */
// Tasks referenced by these tables (dev_cycles, task_chat_messages,
// pr_review_requests, code_change_requests) can't be hard-deleted — their
// task_id FK has no ON DELETE CASCADE, so a bulk DELETE touching even one
// referenced row aborts the whole statement with "FOREIGN KEY constraint
// failed" and takes every other stale task for that source down with it,
// repeating on every sync cycle forever. Skip referenced ids instead of
// deleting them; they go stale (no longer refreshed) but the row survives
// for whatever still points at it.
const REFERENCED_TASK_IDS_SQL = `
  SELECT task_id FROM dev_cycles WHERE task_id IS NOT NULL
  UNION SELECT task_id FROM task_chat_messages
  UNION SELECT task_id FROM pr_review_requests
  UNION SELECT task_id FROM code_change_requests WHERE task_id IS NOT NULL
`;

// Same "skip, don't delete" treatment for manually_added tasks (see
// addManualTask() in src/orchestrator/manualTask.ts) — a manually-entered
// Jira key/Bitbucket PR isn't necessarily assigned-to-me/a review-request-
// for-me, so it won't be in a sync's fresh `keepExternalRefs`, and without
// this it would vanish on the very next sync of that source.
export function pruneTasksForSource(source: TaskSource, keepExternalRefs: string[]): void {
  const notInKeepSql = keepExternalRefs.length === 0 ? '1=1' : `external_ref NOT IN (${keepExternalRefs.map(() => '?').join(',')})`;
  const keepParams = keepExternalRefs.length === 0 ? [] : keepExternalRefs;

  // A referenced task (pr_review_requests, dev_cycles, ...) can't be
  // hard-deleted below (FK constraint — see REFERENCED_TASK_IDS_SQL's
  // comment) — confirmed live: a PR reviewed through Speako and then
  // approved (either via Speako's own decision draft or directly on
  // Bitbucket) stayed in the open queue forever, because the DELETE below
  // always skipped it and nothing else ever moved it out of 'open'.
  // Dismissing it here instead is the equivalent "it no longer belongs in
  // the queue" outcome that non-referenced tasks get via deletion.
  db.prepare(
    `UPDATE tasks SET status = 'dismissed', updated_at = datetime('now')
     WHERE source = ? AND ${notInKeepSql} AND manually_added = 0 AND status = 'open' AND id IN (${REFERENCED_TASK_IDS_SQL})`
  ).run(source, ...keepParams);

  db.prepare(
    `DELETE FROM tasks WHERE source = ? AND ${notInKeepSql} AND manually_added = 0 AND id NOT IN (${REFERENCED_TASK_IDS_SQL})`
  ).run(source, ...keepParams);
}

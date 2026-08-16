import { db } from './db';

export type TaskSource = 'jira' | 'bitbucket_pr' | 'action_item' | 'teams_message' | 'email_message' | 'jenkins_build';
export type TaskStatus = 'open' | 'dismissed';
export type TaskBoardStatus = 'todo' | 'in_progress' | 'done';

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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const upsertStmt = db.prepare(`
  INSERT INTO tasks (source, external_ref, title, description, url, due_date, urgency_score, importance_score, priority_score, draft_reply)
  VALUES (@source, @externalRef, @title, @description, @url, @dueDate, @urgencyScore, @importanceScore, @priorityScore, @draftReply)
  ON CONFLICT(source, external_ref) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    url = excluded.url,
    due_date = excluded.due_date,
    urgency_score = excluded.urgency_score,
    importance_score = excluded.importance_score,
    priority_score = excluded.priority_score,
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
  });
}

export function getOpenTasks(): Task[] {
  const rows = db.prepare(`SELECT * FROM tasks WHERE status = 'open' ORDER BY priority_score DESC`).all() as any[];
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
  const rows = db.prepare(`SELECT * FROM tasks WHERE status = 'open' AND created_at >= datetime(?) ORDER BY priority_score DESC`).all(iso) as any[];
  return rows.map(mapRow);
}

export function getTaskById(id: number): Task | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function dismissTask(id: number): void {
  db.prepare(`UPDATE tasks SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** Moves a task between kanban columns (Dashboard drag-and-drop) — deliberately not touched by upsertTask's ON CONFLICT, so a re-sync never snaps a dragged card back to 'todo'. */
export function updateTaskBoardStatus(id: number, boardStatus: TaskBoardStatus): void {
  db.prepare(`UPDATE tasks SET board_status = ?, updated_at = datetime('now') WHERE id = ?`).run(boardStatus, id);
}

/** Removes every task for a source not present in `keepExternalRefs` — prunes items that no longer qualify (e.g. a PR merged/closed since the last sync) without re-touching rows that are still current. */
export function pruneTasksForSource(source: TaskSource, keepExternalRefs: string[]): void {
  if (keepExternalRefs.length === 0) {
    db.prepare(`DELETE FROM tasks WHERE source = ?`).run(source);
    return;
  }
  const placeholders = keepExternalRefs.map(() => '?').join(',');
  db.prepare(`DELETE FROM tasks WHERE source = ? AND external_ref NOT IN (${placeholders})`).run(source, ...keepExternalRefs);
}

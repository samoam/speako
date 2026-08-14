import { db } from './db';

export type TaskSource = 'jira' | 'bitbucket_pr' | 'action_item';
export type TaskStatus = 'open' | 'dismissed';

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
  status: TaskStatus;
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
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const upsertStmt = db.prepare(`
  INSERT INTO tasks (source, external_ref, title, description, url, due_date, urgency_score, importance_score, priority_score)
  VALUES (@source, @externalRef, @title, @description, @url, @dueDate, @urgencyScore, @importanceScore, @priorityScore)
  ON CONFLICT(source, external_ref) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    url = excluded.url,
    due_date = excluded.due_date,
    urgency_score = excluded.urgency_score,
    importance_score = excluded.importance_score,
    priority_score = excluded.priority_score,
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
  });
}

export function getOpenTasks(): Task[] {
  const rows = db.prepare(`SELECT * FROM tasks WHERE status = 'open' ORDER BY priority_score DESC`).all() as any[];
  return rows.map(mapRow);
}

export function dismissTask(id: number): void {
  db.prepare(`UPDATE tasks SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?`).run(id);
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

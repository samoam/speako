import { db } from './db';

export type CodeChangeStatus = 'running' | 'ready' | 'applied' | 'pushed' | 'discarded' | 'failed';
export type CodeChangeOrigin = 'action_item' | 'task' | 'dev_plan' | 'jenkins_fix';

export interface CodeChangeRequest {
  id: number;
  actionItemId: number | null;
  taskId: number | null;
  sessionId: string | null;
  devCycleId: number | null;
  origin: CodeChangeOrigin;
  repoName: string;
  repoPath: string;
  cliSessionId: string;
  worktreePath: string | null;
  status: CodeChangeStatus;
  diff: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function mapRow(row: any): CodeChangeRequest {
  return {
    id: row.id,
    actionItemId: row.action_item_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    devCycleId: row.dev_cycle_id,
    origin: row.origin,
    repoName: row.repo_name,
    repoPath: row.repo_path,
    cliSessionId: row.cli_session_id,
    worktreePath: row.worktree_path,
    status: row.status,
    diff: row.diff,
    error: row.error,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Exactly one of actionItemId/taskId is normally set (a meeting-action-item
 * or Jira-Dashboard-card origin) — a dev-cycle-originated row (devCycleId
 * set, origin 'dev_plan'|'jenkins_fix') may additionally set taskId (the My
 * Plate card the cycle started from) alongside devCycleId. sessionId is only
 * meaningful for the action_item origin. For a dev-cycle row, repoPath
 * should be the cycle's OWN long-lived branch worktree (dev_cycles.worktree_path)
 * — see db.ts's comment on the dev_cycle_id/origin columns for why.
 */
export function createCodeChangeRequest(params: {
  actionItemId?: number;
  taskId?: number;
  sessionId?: string;
  devCycleId?: number;
  origin?: CodeChangeOrigin;
  repoName: string;
  repoPath: string;
  cliSessionId: string;
}): CodeChangeRequest {
  const result = db
    .prepare(
      `INSERT INTO code_change_requests (action_item_id, task_id, session_id, dev_cycle_id, origin, repo_name, repo_path, cli_session_id)
       VALUES (@actionItemId, @taskId, @sessionId, @devCycleId, @origin, @repoName, @repoPath, @cliSessionId)`
    )
    .run({
      actionItemId: params.actionItemId ?? null,
      taskId: params.taskId ?? null,
      sessionId: params.sessionId ?? null,
      devCycleId: params.devCycleId ?? null,
      origin: params.origin ?? (params.actionItemId ? 'action_item' : 'task'),
      repoName: params.repoName,
      repoPath: params.repoPath,
      cliSessionId: params.cliSessionId,
    });
  return getCodeChangeRequest(result.lastInsertRowid as number)!;
}

/** Requests for a given dev cycle, most recent first — used to find the latest implementation attempt for a plan round. */
export function getCodeChangeRequestsForDevCycle(devCycleId: number): CodeChangeRequest[] {
  const rows = db.prepare('SELECT * FROM code_change_requests WHERE dev_cycle_id = ? ORDER BY id DESC').all(devCycleId) as any[];
  return rows.map(mapRow);
}

export function getCodeChangeRequest(id: number): CodeChangeRequest | undefined {
  const row = db.prepare('SELECT * FROM code_change_requests WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** Most recent request for an action item — the UI only ever shows/acts on the latest one, older attempts are just history. */
export function getLatestCodeChangeRequestForActionItem(actionItemId: number): CodeChangeRequest | undefined {
  const row = db
    .prepare('SELECT * FROM code_change_requests WHERE action_item_id = ? ORDER BY id DESC LIMIT 1')
    .get(actionItemId) as any;
  return row ? mapRow(row) : undefined;
}

/** Same idea as getLatestCodeChangeRequestForActionItem, for a Jira Dashboard card (src/interface/server.ts's POST /api/plate/:id/implement). */
export function getLatestCodeChangeRequestForTask(taskId: number): CodeChangeRequest | undefined {
  const row = db
    .prepare('SELECT * FROM code_change_requests WHERE task_id = ? ORDER BY id DESC LIMIT 1')
    .get(taskId) as any;
  return row ? mapRow(row) : undefined;
}

/** Requests still 'running' — used on server startup to reconcile against claude agents --json (a request could have finished while Speako wasn't watching, e.g. across a restart). */
export function getRunningCodeChangeRequests(): CodeChangeRequest[] {
  const rows = db.prepare("SELECT * FROM code_change_requests WHERE status = 'running'").all() as any[];
  return rows.map(mapRow);
}

export function markCodeChangeReady(id: number, worktreePath: string, diff: string): void {
  db.prepare("UPDATE code_change_requests SET status = 'ready', worktree_path = ?, diff = ? WHERE id = ?").run(worktreePath, diff, id);
}

export function markCodeChangeFailed(id: number, error: string): void {
  db.prepare("UPDATE code_change_requests SET status = 'failed', error = ?, resolved_at = datetime('now') WHERE id = ?").run(error, id);
}

export function markCodeChangeApplied(id: number): void {
  db.prepare("UPDATE code_change_requests SET status = 'applied' WHERE id = ?").run(id);
}

export function markCodeChangePushed(id: number): void {
  db.prepare("UPDATE code_change_requests SET status = 'pushed', resolved_at = datetime('now') WHERE id = ?").run(id);
}

export function markCodeChangeDiscarded(id: number): void {
  db.prepare("UPDATE code_change_requests SET status = 'discarded', resolved_at = datetime('now') WHERE id = ?").run(id);
}

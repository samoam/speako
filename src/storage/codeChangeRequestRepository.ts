import { db } from './db';

export type CodeChangeStatus = 'running' | 'ready' | 'applied' | 'pushed' | 'discarded' | 'failed';

export interface CodeChangeRequest {
  id: number;
  actionItemId: number;
  sessionId: string;
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
    sessionId: row.session_id,
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

export function createCodeChangeRequest(params: {
  actionItemId: number;
  sessionId: string;
  repoName: string;
  repoPath: string;
  cliSessionId: string;
}): CodeChangeRequest {
  const result = db
    .prepare(
      `INSERT INTO code_change_requests (action_item_id, session_id, repo_name, repo_path, cli_session_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(params.actionItemId, params.sessionId, params.repoName, params.repoPath, params.cliSessionId);
  return getCodeChangeRequest(result.lastInsertRowid as number)!;
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

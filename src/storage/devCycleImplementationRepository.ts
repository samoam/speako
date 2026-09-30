import { db } from './db';

export type DevCycleImplementationVariant = 'claude' | 'gemini';
export type DevCycleImplementationStatus = 'running' | 'ready' | 'failed';

/**
 * One row per (dev cycle, round, variant) — tracks the two parallel
 * Claude/Antigravity implementation attempts of the same approved plan (see
 * src/interface/server.ts's registerJiraImplementRoutes Implement step) so
 * the merge step can diff and reconcile them. The claude variant also has a
 * corresponding code_change_requests row (codeChangeRequestId) polled by the
 * existing pollCodeChangeRequest; the 'gemini' variant (Antigravity, run via
 * antigravityCli.ts's runAntigravityAgent — kept as the historical name for
 * this column's value) has no such row: it's a plain synchronous await with
 * no PID/session to poll, so cliSessionId is just the fixed string
 * 'antigravity' rather than something looked up later.
 */
export interface DevCycleImplementation {
  id: number;
  devCycleId: number;
  round: number;
  variant: DevCycleImplementationVariant;
  worktreePath: string;
  codeChangeRequestId: number | null;
  cliSessionId: string | null;
  status: DevCycleImplementationStatus;
  diff: string | null;
  error: string | null;
  log: string[];
  createdAt: string;
  resolvedAt: string | null;
}

function mapRow(row: any): DevCycleImplementation {
  return {
    id: row.id,
    devCycleId: row.dev_cycle_id,
    round: row.round,
    variant: row.variant,
    worktreePath: row.worktree_path,
    codeChangeRequestId: row.code_change_request_id,
    cliSessionId: row.cli_session_id,
    status: row.status,
    diff: row.diff,
    error: row.error,
    log: row.log ? JSON.parse(row.log) : [],
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function createDevCycleImplementation(params: {
  devCycleId: number;
  round: number;
  variant: DevCycleImplementationVariant;
  worktreePath: string;
  codeChangeRequestId?: number;
  cliSessionId?: string;
}): DevCycleImplementation {
  const result = db
    .prepare(
      `INSERT INTO dev_cycle_implementations (dev_cycle_id, round, variant, worktree_path, code_change_request_id, cli_session_id)
       VALUES (@devCycleId, @round, @variant, @worktreePath, @codeChangeRequestId, @cliSessionId)`
    )
    .run({
      devCycleId: params.devCycleId,
      round: params.round,
      variant: params.variant,
      worktreePath: params.worktreePath,
      codeChangeRequestId: params.codeChangeRequestId ?? null,
      cliSessionId: params.cliSessionId ?? null,
    });
  return getDevCycleImplementation(result.lastInsertRowid as number)!;
}

export function getDevCycleImplementation(id: number): DevCycleImplementation | undefined {
  const row = db.prepare('SELECT * FROM dev_cycle_implementations WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** Both (or however many exist) attempts for a cycle's current round — the merge step's input. */
export function getDevCycleImplementationsForCycle(devCycleId: number, round: number): DevCycleImplementation[] {
  const rows = db
    .prepare('SELECT * FROM dev_cycle_implementations WHERE dev_cycle_id = ? AND round = ? ORDER BY id ASC')
    .all(devCycleId, round) as any[];
  return rows.map(mapRow);
}

/** Read-modify-write on the small JSON array — same convention as appendCodeChangeLog/appendPrReviewLog. */
export function appendDevCycleImplementationLog(id: number, message: string): void {
  const existing = getDevCycleImplementation(id)?.log ?? [];
  const updated = [...existing, message];
  db.prepare('UPDATE dev_cycle_implementations SET log = ? WHERE id = ?').run(JSON.stringify(updated), id);
}

export function markDevCycleImplementationReady(id: number, diff: string): void {
  db.prepare("UPDATE dev_cycle_implementations SET status = 'ready', diff = ?, resolved_at = datetime('now') WHERE id = ?").run(diff, id);
}

export function markDevCycleImplementationFailed(id: number, error: string): void {
  db.prepare("UPDATE dev_cycle_implementations SET status = 'failed', error = ?, resolved_at = datetime('now') WHERE id = ?").run(error, id);
}

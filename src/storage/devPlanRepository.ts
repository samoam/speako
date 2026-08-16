import { db } from './db';

export type DevPlanStatus = 'running' | 'ready' | 'approved' | 'rejected' | 'superseded' | 'failed';

export interface DevPlan {
  id: number;
  devCycleId: number;
  round: number;
  attempt: number;
  status: DevPlanStatus;
  plan: any;
  seedContext: any;
  feedback: string | null;
  log: string[];
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function safeJsonParse(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapRow(row: any): DevPlan {
  return {
    id: row.id,
    devCycleId: row.dev_cycle_id,
    round: row.round,
    attempt: row.attempt,
    status: row.status,
    plan: safeJsonParse(row.plan),
    seedContext: safeJsonParse(row.seed_context),
    feedback: row.feedback,
    log: row.log ? JSON.parse(row.log) : [],
    error: row.error,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function createDevPlan(params: { devCycleId: number; round: number; attempt?: number; seedContext?: unknown; feedback?: string }): DevPlan {
  const result = db
    .prepare(
      `INSERT INTO dev_plans (dev_cycle_id, round, attempt, seed_context, feedback)
       VALUES (@devCycleId, @round, @attempt, @seedContext, @feedback)`
    )
    .run({
      devCycleId: params.devCycleId,
      round: params.round,
      attempt: params.attempt ?? 1,
      seedContext: params.seedContext !== undefined ? JSON.stringify(params.seedContext) : null,
      feedback: params.feedback ?? null,
    });
  return getDevPlan(result.lastInsertRowid as number)!;
}

export function getDevPlan(id: number): DevPlan | undefined {
  const row = db.prepare('SELECT * FROM dev_plans WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** The UI only ever shows/acts on the latest attempt for a cycle — earlier attempts (including superseded ones) are history. */
export function getLatestDevPlanForCycle(devCycleId: number): DevPlan | undefined {
  const row = db.prepare('SELECT * FROM dev_plans WHERE dev_cycle_id = ? ORDER BY id DESC LIMIT 1').get(devCycleId) as any;
  return row ? mapRow(row) : undefined;
}

export function appendDevPlanLog(id: number, message: string): void {
  const existing = getDevPlan(id)?.log ?? [];
  const updated = [...existing, message];
  db.prepare('UPDATE dev_plans SET log = ? WHERE id = ?').run(JSON.stringify(updated), id);
}

export function markDevPlanReady(id: number, plan: unknown): void {
  db.prepare("UPDATE dev_plans SET status = 'ready', plan = ?, resolved_at = datetime('now') WHERE id = ?").run(JSON.stringify(plan), id);
}

export function markDevPlanFailed(id: number, error: string): void {
  db.prepare("UPDATE dev_plans SET status = 'failed', error = ?, resolved_at = datetime('now') WHERE id = ?").run(error, id);
}

export function markDevPlanApproved(id: number): void {
  db.prepare("UPDATE dev_plans SET status = 'approved' WHERE id = ?").run(id);
}

export function markDevPlanRejected(id: number): void {
  db.prepare("UPDATE dev_plans SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(id);
}

/** Marks every non-terminal plan for a cycle as superseded before a new attempt starts, so exactly one plan is ever "live" (running/ready) at a time. */
export function supersedeOpenPlansForCycle(devCycleId: number): void {
  db.prepare("UPDATE dev_plans SET status = 'superseded' WHERE dev_cycle_id = ? AND status IN ('running', 'ready')").run(devCycleId);
}

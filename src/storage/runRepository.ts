import { db } from './db';
import { stampLogLine } from './logLine';

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled';
export type RunStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'failed', 'cancelled'];

/** Same shape as prReviewRequestRepository's PrReviewPhase, so the existing checklist UI renders a run's steps unchanged. */
export interface RunStep {
  key: string;
  label: string;
  status: RunStepStatus;
  detail: string | null;
}

export interface Run<S = any> {
  id: number;
  kind: string;
  subjectKind: string;
  subjectId: string;
  status: RunStatus;
  steps: RunStep[];
  state: S;
  currentStep: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** 'approval' is how a human's go-ahead is recorded — an event rather than a column, so the engine's resume check (hasRunEvent) survives a restart and the transcript shows when it happened. */
export type RunEventKind = 'log' | 'step' | 'approval';

export interface RunEvent {
  id: number;
  runId: number;
  kind: RunEventKind;
  stepKey: string | null;
  /** Time-stamped like every other progress log in the app ("[ISO] message", see logLine.ts). */
  message: string;
  createdAt: string;
}

function mapRow(row: any): Run {
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    status: row.status,
    steps: JSON.parse(row.steps),
    state: row.state ? JSON.parse(row.state) : {},
    currentStep: row.current_step,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export function createRun<S>(params: { kind: string; subjectKind: string; subjectId: string; steps: RunStep[]; state: S }): Run<S> {
  const result = db
    .prepare(`INSERT INTO orchestration_runs (kind, subject_kind, subject_id, steps, state) VALUES (?, ?, ?, ?, ?)`)
    .run(params.kind, params.subjectKind, params.subjectId, JSON.stringify(params.steps), JSON.stringify(params.state));
  return getRun(result.lastInsertRowid as number)! as Run<S>;
}

export function getRun(id: number): Run | undefined {
  const row = db.prepare('SELECT * FROM orchestration_runs WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function getLatestRunForSubject(subjectKind: string, subjectId: string): Run | undefined {
  const row = db.prepare('SELECT * FROM orchestration_runs WHERE subject_kind = ? AND subject_id = ? ORDER BY id DESC LIMIT 1').get(subjectKind, subjectId) as any;
  return row ? mapRow(row) : undefined;
}

export function getRunsByStatus(statuses: readonly RunStatus[]): Run[] {
  if (!statuses.length) return [];
  const rows = db.prepare(`SELECT * FROM orchestration_runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id ASC`).all(...statuses) as any[];
  return rows.map(mapRow);
}

/**
 * Compare-and-swap status write — the engine only ever moves a run along
 * the enum from a status it believes the run is in, so a cancel that landed
 * from the API in between can't be overwritten by the worker's own
 * 'running'/'done' write (same reasoning as draftRepository's
 * tryTransitionDraft). Returns false if the row wasn't in one of `from`.
 */
export function tryTransitionRun(id: number, from: readonly RunStatus[], to: RunStatus, error: string | null = null): boolean {
  const resolved = TERMINAL_RUN_STATUSES.includes(to) ? "datetime('now')" : 'NULL';
  const result = db
    .prepare(`UPDATE orchestration_runs SET status = ?, error = ?, updated_at = datetime('now'), resolved_at = ${resolved} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
    .run(to, error, id, ...from);
  return result.changes > 0;
}

export function setRunState(id: number, state: unknown): void {
  db.prepare("UPDATE orchestration_runs SET state = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(state), id);
}

/** Updates one step by key (read-modify-write on the small snapshot) and records the transition in run_events. No-op for an unknown key. */
export function setRunStep(id: number, key: string, status: RunStepStatus, detail: string | null = null): void {
  const run = getRun(id);
  if (!run) return;
  const steps = run.steps.map((s) => (s.key === key ? { ...s, status, detail } : s));
  db.prepare("UPDATE orchestration_runs SET steps = ?, current_step = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(steps), status === 'running' ? key : run.currentStep, id);
  appendRunEvent(id, 'step', key, detail ? `${key}: ${status} — ${detail}` : `${key}: ${status}`);
}

/** The step the run is parked on at waiting_approval — approveRun() reads it back to record which gate was approved. */
export function setRunCurrentStep(id: number, key: string): void {
  db.prepare("UPDATE orchestration_runs SET current_step = ?, updated_at = datetime('now') WHERE id = ?").run(key, id);
}

export function appendRunEvent(runId: number, kind: RunEventKind, stepKey: string | null, message: string): void {
  db.prepare('INSERT INTO run_events (run_id, kind, step_key, message) VALUES (?, ?, ?, ?)').run(runId, kind, stepKey, stampLogLine(message));
}

export function hasRunEvent(runId: number, kind: RunEventKind, stepKey: string): boolean {
  return !!db.prepare('SELECT 1 FROM run_events WHERE run_id = ? AND kind = ? AND step_key = ? LIMIT 1').get(runId, kind, stepKey);
}

/** The gate steps a human approved in this run — carried over by the engine's retryRun so a retry doesn't ask again. */
export function getRunApprovedSteps(runId: number): string[] {
  const rows = db.prepare("SELECT DISTINCT step_key FROM run_events WHERE run_id = ? AND kind = 'approval' AND step_key IS NOT NULL").all(runId) as { step_key: string }[];
  return rows.map((r) => r.step_key);
}

/** The 'log' lines of a run in order — what the UI shows as the progress transcript. */
export function getRunLog(runId: number): string[] {
  const rows = db.prepare("SELECT message FROM run_events WHERE run_id = ? AND kind = 'log' ORDER BY id ASC").all(runId) as { message: string }[];
  return rows.map((r) => r.message);
}

/** At startup every 'running' row is orphaned (the process that ran it is gone) — failed up front so the UI offers a retry instead of showing "Running" forever. Steps still 'running' are failed too. Returns how many runs were reset. */
export function failInterruptedRuns(error: string): number {
  let count = 0;
  for (const run of getRunsByStatus(['running'])) {
    for (const step of run.steps) if (step.status === 'running') setRunStep(run.id, step.key, 'failed', error);
    if (tryTransitionRun(run.id, ['running'], 'failed', error)) count++;
  }
  return count;
}

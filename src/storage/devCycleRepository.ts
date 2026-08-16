import { db } from './db';

/** Semantic Jira lifecycle state this cycle is currently in — see src/dev/lifecycle.ts for the fixed transition graph this must stay within. */
export type LifecycleState = 'Evaluation' | 'On Hold' | 'Dev Ready' | 'In Progress' | 'QA Ready' | 'Return' | 'Release';
export type BranchType = 'feature' | 'bugfix' | 'hotfix' | 'chore';
export type DevCycleStatus = 'active' | 'done' | 'abandoned';

export interface DevCycle {
  id: number;
  ticketKey: string;
  taskId: number | null;
  repoName: string;
  repoPath: string;
  branchType: BranchType;
  branchName: string | null;
  baseBranch: string;
  worktreePath: string | null;
  lifecycleState: LifecycleState;
  round: number;
  prProjectKey: string | null;
  prRepoSlug: string | null;
  prId: number | null;
  prUrl: string | null;
  jenkinsJobPath: string | null;
  status: DevCycleStatus;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: any): DevCycle {
  return {
    id: row.id,
    ticketKey: row.ticket_key,
    taskId: row.task_id,
    repoName: row.repo_name,
    repoPath: row.repo_path,
    branchType: row.branch_type,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    worktreePath: row.worktree_path,
    lifecycleState: row.lifecycle_state,
    round: row.round,
    prProjectKey: row.pr_project_key,
    prRepoSlug: row.pr_repo_slug,
    prId: row.pr_id,
    prUrl: row.pr_url,
    jenkinsJobPath: row.jenkins_job_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDevCycle(params: {
  ticketKey: string;
  taskId?: number;
  repoName: string;
  repoPath: string;
  branchType: BranchType;
  baseBranch?: string;
  lifecycleState: LifecycleState;
}): DevCycle {
  const result = db
    .prepare(
      `INSERT INTO dev_cycles (ticket_key, task_id, repo_name, repo_path, branch_type, base_branch, lifecycle_state)
       VALUES (@ticketKey, @taskId, @repoName, @repoPath, @branchType, @baseBranch, @lifecycleState)`
    )
    .run({
      ticketKey: params.ticketKey,
      taskId: params.taskId ?? null,
      repoName: params.repoName,
      repoPath: params.repoPath,
      branchType: params.branchType,
      baseBranch: params.baseBranch ?? 'main',
      lifecycleState: params.lifecycleState,
    });
  return getDevCycle(result.lastInsertRowid as number)!;
}

export function getDevCycle(id: number): DevCycle | undefined {
  const row = db.prepare('SELECT * FROM dev_cycles WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** At most one active cycle per ticket (enforced by idx_dev_cycles_ticket_active) — this is how a Return loop finds the existing cycle to reuse instead of creating a second one. */
export function getActiveDevCycleForTicket(ticketKey: string): DevCycle | undefined {
  const row = db.prepare("SELECT * FROM dev_cycles WHERE ticket_key = ? AND status = 'active'").get(ticketKey) as any;
  return row ? mapRow(row) : undefined;
}

export function getActiveDevCycles(): DevCycle[] {
  const rows = db.prepare("SELECT * FROM dev_cycles WHERE status = 'active'").all() as any[];
  return rows.map(mapRow);
}

export function setDevCycleBranch(id: number, params: { branchName: string; worktreePath: string }): void {
  db.prepare("UPDATE dev_cycles SET branch_name = ?, worktree_path = ?, updated_at = datetime('now') WHERE id = ?").run(
    params.branchName,
    params.worktreePath,
    id
  );
}

export function setDevCycleState(id: number, state: LifecycleState): void {
  db.prepare("UPDATE dev_cycles SET lifecycle_state = ?, updated_at = datetime('now') WHERE id = ?").run(state, id);
}

export function setDevCyclePr(id: number, params: { projectKey: string; repoSlug: string; prId: number; prUrl: string }): void {
  db.prepare(
    "UPDATE dev_cycles SET pr_project_key = ?, pr_repo_slug = ?, pr_id = ?, pr_url = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(params.projectKey, params.repoSlug, params.prId, params.prUrl, id);
}

export function setDevCycleJenkinsJob(id: number, jobPath: string): void {
  db.prepare("UPDATE dev_cycles SET jenkins_job_path = ?, updated_at = datetime('now') WHERE id = ?").run(jobPath, id);
}

/** Called on entering the Return loop — a new plan/implementation round for the same ticket/branch, not a new cycle. */
export function bumpDevCycleRound(id: number): void {
  db.prepare("UPDATE dev_cycles SET round = round + 1, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function closeDevCycle(id: number, status: Extract<DevCycleStatus, 'done' | 'abandoned'>): void {
  db.prepare("UPDATE dev_cycles SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

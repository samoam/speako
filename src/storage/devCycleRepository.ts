import { db } from './db';
import type { StructuredDevPlan } from '../dev/devPlan';

/** Semantic Jira lifecycle state this cycle is currently in — see src/dev/lifecycle.ts for the fixed transition graph this must stay within. */
export type LifecycleState = 'Evaluation' | 'On Hold' | 'Dev Ready' | 'In Progress' | 'QA Ready' | 'Return' | 'Release';
export type BranchType = 'feature' | 'bugfix' | 'hotfix' | 'chore';
export type DevCycleStatus = 'active' | 'done' | 'abandoned';

export type DevCyclePhaseStatus = 'pending' | 'running' | 'done' | 'failed';

/** The Jira-implement tab's top-level checklist (src/interface/server.ts's buildJiraImplementPhases) — same shape as PrReviewPhase, one row per pipeline step: analyze, plan, branch_and_worktrees, implement, merge_and_review. */
export interface DevCyclePhase {
  key: string;
  label: string;
  status: DevCyclePhaseStatus;
  detail: string | null;
}

/** Which pipeline step is currently unlocked — the server-side gate every /api/jira-implement/:id/* route checks before acting, not just a UI cue. Null on cycles created before this pipeline existed (see openJiraImplementTab's legacy fallback). */
export type DevCycleStep = 'analyze' | 'plan' | 'branch_and_worktrees' | 'implement' | 'merge_and_review' | 'done';

export interface DevCycleAnalysisContext {
  ticket: { key: string; summary: string; status: string; description: string };
  confluencePages: { title: string }[];
  codeHits: { filePath: string }[];
  relatedPrs: { title: string; url: string; state: string }[];
}

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
  worktreePathGemini: string | null;
  lifecycleState: LifecycleState;
  round: number;
  prProjectKey: string | null;
  prRepoSlug: string | null;
  prId: number | null;
  prUrl: string | null;
  jenkinsJobPath: string | null;
  status: DevCycleStatus;
  phases: DevCyclePhase[];
  log: string[];
  currentStep: DevCycleStep | null;
  analysisContext: DevCycleAnalysisContext | null;
  planClaude: StructuredDevPlan | null;
  planGemini: StructuredDevPlan | null;
  planMerged: StructuredDevPlan | null;
  createdAt: string;
  updatedAt: string;
}

/** Tolerates malformed/absent JSON on older rows rather than throwing — same defensive parsing as prReviewRequestRepository.ts's safeJsonParse. */
function safeJsonParse(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
    worktreePathGemini: row.worktree_path_gemini,
    lifecycleState: row.lifecycle_state,
    round: row.round,
    prProjectKey: row.pr_project_key,
    prRepoSlug: row.pr_repo_slug,
    prId: row.pr_id,
    prUrl: row.pr_url,
    jenkinsJobPath: row.jenkins_job_path,
    status: row.status,
    phases: row.phases ? JSON.parse(row.phases) : [],
    log: row.log ? JSON.parse(row.log) : [],
    currentStep: row.current_step,
    analysisContext: safeJsonParse(row.analysis_context),
    planClaude: safeJsonParse(row.plan_claude),
    planGemini: safeJsonParse(row.plan_gemini),
    planMerged: safeJsonParse(row.plan_merged),
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

/** Corrects a cycle's trunk branch after the fact — e.g. it was created while config.devTrunkBranch was set to the wrong value for this repo, and branch/worktree creation failed with "couldn't find remote ref". Used by the Jira-implement tab's retry flow, which prompts for a replacement value only when a failed phase's error looks like this specific mismatch. */
export function setDevCycleBaseBranch(id: number, baseBranch: string): void {
  db.prepare("UPDATE dev_cycles SET base_branch = ?, updated_at = datetime('now') WHERE id = ?").run(baseBranch, id);
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

/** Seeds the full step list as 'pending' right after the cycle is created — mirrors initPrReviewPhases (prReviewRequestRepository.ts) so the Jira-implement tab can render its whole planned pipeline immediately. */
export function initDevCyclePhases(id: number, phases: DevCyclePhase[]): void {
  db.prepare("UPDATE dev_cycles SET phases = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(phases), id);
}

/** Read-modify-write on the small JSON array — same convention as setPrReviewPhase, silently a no-op if the key isn't found. */
export function setDevCyclePhase(id: number, key: string, status: DevCyclePhaseStatus, detail: string | null = null): void {
  const existing = getDevCycle(id)?.phases ?? [];
  const updated = existing.map((p) => (p.key === key ? { ...p, status, detail } : p));
  db.prepare("UPDATE dev_cycles SET phases = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(updated), id);
}

/** Appends one progress line — same convention as appendPrReviewLog. */
export function appendDevCycleLog(id: number, message: string): void {
  const existing = getDevCycle(id)?.log ?? [];
  const updated = [...existing, message];
  db.prepare("UPDATE dev_cycles SET log = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(updated), id);
}

/** The server-side gate every /api/jira-implement/:id/* route checks before acting (see registerJiraImplementRoutes) — only ever set from inside the pipeline's own orchestration, never from a client-supplied value. */
export function setDevCycleCurrentStep(id: number, step: DevCycleStep): void {
  db.prepare("UPDATE dev_cycles SET current_step = ?, updated_at = datetime('now') WHERE id = ?").run(step, id);
}

export function setDevCycleAnalysisContext(id: number, context: DevCycleAnalysisContext): void {
  db.prepare("UPDATE dev_cycles SET analysis_context = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(context), id);
}

export function setDevCyclePlans(
  id: number,
  plans: { claude?: StructuredDevPlan | null; gemini?: StructuredDevPlan | null; merged?: StructuredDevPlan | null }
): void {
  const existing = getDevCycle(id);
  const claude = plans.claude !== undefined ? plans.claude : existing?.planClaude ?? null;
  const gemini = plans.gemini !== undefined ? plans.gemini : existing?.planGemini ?? null;
  const merged = plans.merged !== undefined ? plans.merged : existing?.planMerged ?? null;
  db.prepare(
    "UPDATE dev_cycles SET plan_claude = ?, plan_gemini = ?, plan_merged = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(claude ? JSON.stringify(claude) : null, gemini ? JSON.stringify(gemini) : null, merged ? JSON.stringify(merged) : null, id);
}

/** Sets both worktree paths at once — worktree A (Claude's, this cycle's primary worktree — what applyCodeChangeToRepo/pr_open ultimately operate on) via the pre-existing worktree_path column, worktree B (Gemini's) via worktree_path_gemini. Distinct from setDevCycleBranch, which callers still use for the branch-name+worktree-A pairing at branch-creation time; this is for adding worktree B afterward without re-touching the branch name. */
export function setDevCycleWorktrees(id: number, params: { worktreePath?: string; worktreePathGemini?: string }): void {
  const existing = getDevCycle(id);
  const worktreePath = params.worktreePath ?? existing?.worktreePath ?? null;
  const worktreePathGemini = params.worktreePathGemini ?? existing?.worktreePathGemini ?? null;
  db.prepare(
    "UPDATE dev_cycles SET worktree_path = ?, worktree_path_gemini = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(worktreePath, worktreePathGemini, id);
}

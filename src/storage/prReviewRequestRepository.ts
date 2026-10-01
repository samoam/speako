import { db } from './db';
import { RunStep } from './runRepository';

export type PrReviewStatus = 'running' | 'ready' | 'failed';

export interface PrReviewContext {
  /** Optional — absent on rows persisted before this field was added. */
  authorName?: string;
  jiraIssues: { key: string; summary: string; status: string }[];
  confluencePages: { title: string }[];
}

export type PrReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export type PrReviewRecommendation = 'approve' | 'request_changes' | 'comment';

/** Which reviewer(s) raised this finding — 'claude'/'gemini' for something only one agent caught ('gemini' meaning the Antigravity second opinion — see antigravityCli.ts), 'both' when mergeReviews (prReviewContext.ts) folded matching findings from each into one. Absent on rows persisted before this field was added, or on a Claude-only review (no second opinion available/enabled) — treat missing as 'claude' since that's the only reviewer that ever ran solo. */
export type PrReviewFindingSource = 'claude' | 'gemini' | 'both';

export interface PrReviewFinding {
  file: string;
  line: number | null;
  severity: PrReviewSeverity;
  comment: string;
  source?: PrReviewFindingSource;
}

/** The review agent's structured output (src/summarization/prReviewContext.ts's REVIEW_JSON_SCHEMA) — a short story-style summary tying the Jira ticket's intent to the code change, plus discrete findings a real code review would leave as inline comments. */
export interface StructuredReview {
  summary: string;
  recommendation: PrReviewRecommendation;
  findings: PrReviewFinding[];
}

/**
 * One step of the review pipeline (src/orchestration/kinds/prReviewRun.ts
 * defines the list) — a coarser-grained companion to `log` below: `log` is
 * the full blow-by-blow transcript (every tool call, every reasoning line),
 * while phases is the handful of high-level stages a user actually wants a
 * status/checkmark for at a glance, each with a short `detail` — the step's
 * own conclusion once it finishes (e.g. the review step's `detail` becomes
 * the review's own summary), not just "done". Same shape as a RunStep.
 */
export type PrReviewPhase = RunStep;

export interface PrReviewRequest {
  id: number;
  taskId: number;
  repoName: string;
  branchName: string;
  status: PrReviewStatus;
  context: PrReviewContext | null;
  review: StructuredReview | null;
  error: string | null;
  /** Timestamped progress lines ("Checking Jira ticket...", "Checking out branch...") — persisted so reopening/reloading the review window mid-run still shows history-so-far, not just future live updates. */
  log: string[];
  /** Absent on rows persisted before this field was added — the UI falls back to the raw log-only view for those. */
  phases: PrReviewPhase[];
  /** The orchestration run executing this review (src/orchestration/kinds/prReviewRun.ts) — it owns the live steps/log; `log`/`phases` above are only authoritative for rows from before runs existed (null here). */
  runId: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Tolerates rows written before `review` held structured JSON (plain review text from an earlier version of this feature) — falls back to null rather than crashing the request. */
function safeJsonParse(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapRow(row: any): PrReviewRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    repoName: row.repo_name,
    branchName: row.branch_name,
    status: row.status,
    context: safeJsonParse(row.context),
    review: safeJsonParse(row.review),
    error: row.error,
    log: row.log ? JSON.parse(row.log) : [],
    phases: row.phases ? JSON.parse(row.phases) : [],
    runId: row.run_id ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function createPrReviewRequest(params: { taskId: number; repoName: string; branchName: string }): PrReviewRequest {
  const result = db
    .prepare(`INSERT INTO pr_review_requests (task_id, repo_name, branch_name) VALUES (?, ?, ?)`)
    .run(params.taskId, params.repoName, params.branchName);
  return getPrReviewRequest(result.lastInsertRowid as number)!;
}

export function getPrReviewRequest(id: number): PrReviewRequest | undefined {
  const row = db.prepare('SELECT * FROM pr_review_requests WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** Most recent request for a task — the UI only ever shows/acts on the latest one, older attempts are just history. */
export function getLatestPrReviewRequestForTask(taskId: number): PrReviewRequest | undefined {
  const row = db.prepare('SELECT * FROM pr_review_requests WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId) as any;
  return row ? mapRow(row) : undefined;
}

/** Stores the gathered Jira/Confluence context as soon as it's known — shown in the UI even while the review itself is still running. */
export function setPrReviewContext(id: number, context: PrReviewContext): void {
  db.prepare('UPDATE pr_review_requests SET context = ? WHERE id = ?').run(JSON.stringify(context), id);
}

export function setPrReviewRunId(id: number, runId: number): void {
  db.prepare('UPDATE pr_review_requests SET run_id = ? WHERE id = ?').run(runId, id);
}

/** Strips stray tool-call closing tags (e.g. `</parameter></invoke>`) occasionally leaked onto the end of a text field when the review agent's structured-output generation immediately follows a tool call — seen live in a real review's summary field. */
function stripLeakedToolTags(text: string): string {
  return text.replace(/(\s*<\/[a-zA-Z_][\w-]*>\s*)+$/, '').trimEnd();
}

function sanitizeStructuredReview(review: StructuredReview): StructuredReview {
  return {
    ...review,
    summary: stripLeakedToolTags(review.summary),
    findings: review.findings.map((f) => ({ ...f, comment: stripLeakedToolTags(f.comment) })),
  };
}

export function markPrReviewReady(id: number, review: StructuredReview): void {
  db.prepare("UPDATE pr_review_requests SET status = 'ready', review = ?, resolved_at = datetime('now') WHERE id = ?").run(JSON.stringify(sanitizeStructuredReview(review)), id);
}

/** At startup every 'running' row is orphaned — the process that ran it is gone — so they're failed up front rather than showing "Running" (with no way to retry) until someone happens to start a new review. Returns how many were reset. */
export function failInterruptedPrReviews(error: string): number {
  return db.prepare("UPDATE pr_review_requests SET status = 'failed', error = ?, resolved_at = datetime('now') WHERE status = 'running'").run(error).changes;
}

export function markPrReviewFailed(id: number, error: string): void {
  db.prepare("UPDATE pr_review_requests SET status = 'failed', error = ?, resolved_at = datetime('now') WHERE id = ?").run(error, id);
}

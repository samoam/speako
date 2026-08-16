import { db } from './db';

export type PrReviewStatus = 'running' | 'ready' | 'failed';

export interface PrReviewContext {
  jiraIssues: { key: string; summary: string; status: string }[];
  confluencePages: { title: string }[];
}

export type PrReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export type PrReviewRecommendation = 'approve' | 'request_changes' | 'comment';

export interface PrReviewFinding {
  file: string;
  line: number | null;
  severity: PrReviewSeverity;
  comment: string;
}

/** The review agent's structured output (src/summarization/prReviewContext.ts's REVIEW_JSON_SCHEMA) — a short story-style summary tying the Jira ticket's intent to the code change, plus discrete findings a real code review would leave as inline comments. */
export interface StructuredReview {
  summary: string;
  recommendation: PrReviewRecommendation;
  findings: PrReviewFinding[];
}

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

/** Appends one progress line — read-modify-write on the small JSON array rather than a separate table, since a review only ever has a handful of steps (not an unbounded stream). */
export function appendPrReviewLog(id: number, message: string): void {
  const existing = getPrReviewRequest(id)?.log ?? [];
  const updated = [...existing, message];
  db.prepare('UPDATE pr_review_requests SET log = ? WHERE id = ?').run(JSON.stringify(updated), id);
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

export function markPrReviewFailed(id: number, error: string): void {
  db.prepare("UPDATE pr_review_requests SET status = 'failed', error = ?, resolved_at = datetime('now') WHERE id = ?").run(error, id);
}

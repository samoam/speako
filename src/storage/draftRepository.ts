import { db } from './db';

/** 'awaiting_clarification' is a reply-draft-specific state: the assistant asked the user a clarifying question (a `kind: 'question'` revision) and is waiting on their answer before it can draft — distinct from 'ready' so Approve stays impossible to hit mid-clarification. See src/drafts/kinds/replyDraftShared.ts. */
export type DraftStatus = 'generating' | 'ready' | 'refining' | 'executing' | 'completed' | 'failed' | 'discarded' | 'awaiting_clarification';

export type DraftSubjectKind = 'action_item' | 'task' | 'session' | 'jira_issue' | 'pr_review_request' | 'dev_cycle' | 'dev_plan' | 'jenkins_build';

export type DraftRevisionRole = 'user' | 'assistant';
/** 'question' is the assistant proactively asking the user something (see DraftGenerateResult's 'question' mode) — distinct from 'answer', which is the assistant responding to a question the USER asked. */
export type DraftRevisionKind = 'instruction' | 'draft' | 'answer' | 'manual_edit' | 'note' | 'question';

export interface Draft {
  id: number;
  kind: string;
  subjectKind: DraftSubjectKind;
  subjectId: string;
  status: DraftStatus;
  stage: number;
  content: any;
  resultRef: any;
  error: string | null;
  redoOfDraftId: number | null;
  supersededByDraftId: number | null;
  executionRef: any;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface DraftRevision {
  id: number;
  draftId: number;
  turn: number;
  role: DraftRevisionRole;
  kind: DraftRevisionKind;
  text: string | null;
  content: any;
  createdAt: string;
}

/** Refinement turns can carry a large draft snapshot (e.g. a code diff) — cap what's stored per turn so refining the same draft repeatedly doesn't accumulate megabytes. Full content for large payloads should be referenced via drafts.execution_ref instead of re-snapshotted here. */
const MAX_REVISION_CONTENT_BYTES = 64 * 1024;

/** Tolerates rows written with malformed/missing JSON rather than crashing the caller — same defensive convention as prReviewRequestRepository.ts's safeJsonParse. */
function safeJsonParse(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapDraft(row: any): Draft {
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    status: row.status,
    stage: row.stage,
    content: safeJsonParse(row.content),
    resultRef: safeJsonParse(row.result_ref),
    error: row.error,
    redoOfDraftId: row.redo_of_draft_id,
    supersededByDraftId: row.superseded_by_draft_id,
    executionRef: safeJsonParse(row.execution_ref),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapRevision(row: any): DraftRevision {
  return {
    id: row.id,
    draftId: row.draft_id,
    turn: row.turn,
    role: row.role,
    kind: row.kind,
    text: row.text,
    content: safeJsonParse(row.content),
    createdAt: row.created_at,
  };
}

export function createDraft(params: {
  kind: string;
  subjectKind: DraftSubjectKind;
  subjectId: string | number;
  redoOfDraftId?: number;
  executionRef?: unknown;
}): Draft {
  const result = db
    .prepare(
      `INSERT INTO drafts (kind, subject_kind, subject_id, redo_of_draft_id, execution_ref)
       VALUES (@kind, @subjectKind, @subjectId, @redoOfDraftId, @executionRef)`
    )
    .run({
      kind: params.kind,
      subjectKind: params.subjectKind,
      subjectId: String(params.subjectId),
      redoOfDraftId: params.redoOfDraftId ?? null,
      executionRef: params.executionRef !== undefined ? JSON.stringify(params.executionRef) : null,
    });
  return getDraft(result.lastInsertRowid as number)!;
}

export function getDraft(id: number): Draft | undefined {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as any;
  return row ? mapDraft(row) : undefined;
}

/** Most recent draft of a given kind for a subject — the UI only ever shows/acts on the latest, older attempts (including redo chains) are history reachable via redoOfDraftId. */
export function getLatestDraftForSubject(subjectKind: DraftSubjectKind, subjectId: string | number, kind: string): Draft | undefined {
  const row = db
    .prepare('SELECT * FROM drafts WHERE subject_kind = ? AND subject_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(subjectKind, String(subjectId), kind) as any;
  return row ? mapDraft(row) : undefined;
}

export function getDraftsForSubject(subjectKind: DraftSubjectKind, subjectId: string | number): Draft[] {
  const rows = db
    .prepare('SELECT * FROM drafts WHERE subject_kind = ? AND subject_id = ? ORDER BY id ASC')
    .all(subjectKind, String(subjectId)) as any[];
  return rows.map(mapDraft);
}

/**
 * For kinds whose subjectId is a composite string (e.g. jira_transition's
 * "<devCycleId>:<targetState>", bitbucket_pr_comment's "<prReviewRequestId>:<findingIndex>")
 * — finds every draft of a kind whose subjectId starts with the given
 * prefix, so "all comment drafts for this PR review" is still a single
 * query even though each comment's subjectId also encodes its finding index.
 */
export function getDraftsForSubjectPrefix(subjectKind: DraftSubjectKind, subjectIdPrefix: string, kind: string): Draft[] {
  const rows = db
    .prepare('SELECT * FROM drafts WHERE subject_kind = ? AND subject_id LIKE ? AND kind = ? ORDER BY id ASC')
    .all(subjectKind, `${subjectIdPrefix}%`, kind) as any[];
  return rows.map(mapDraft);
}

/** Startup reconciliation target — rows left mid-flight by a restart (see reconcileStuckDrafts in draftService.ts). */
export function getActiveDraftsByStatus(statuses: DraftStatus[]): Draft[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM drafts WHERE status IN (${placeholders})`).all(...statuses) as any[];
  return rows.map(mapDraft);
}

/**
 * The double-execution guard: a single conditional UPDATE rather than
 * read-then-check-then-write, so two rapid clicks racing across an `await`
 * can't both succeed. Returns true iff this call actually made the
 * transition (i.e. the row was in one of `from` when this ran).
 */
export function tryTransitionDraft(id: number, from: DraftStatus[], to: DraftStatus): boolean {
  if (from.length === 0) return false;
  const placeholders = from.map(() => '?').join(', ');
  const result = db
    .prepare(`UPDATE drafts SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN (${placeholders})`)
    .run(to, id, ...from);
  return result.changes === 1;
}

export function setDraftContent(id: number, content: unknown, opts?: { status?: DraftStatus }): void {
  if (opts?.status) {
    db.prepare("UPDATE drafts SET content = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(content), opts.status, id);
  } else {
    db.prepare("UPDATE drafts SET content = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(content), id);
  }
}

export function setDraftError(id: number, message: string): void {
  db.prepare("UPDATE drafts SET status = 'failed', error = ?, updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?").run(message, id);
}

export function setDraftExecutionRef(id: number, ref: unknown): void {
  db.prepare("UPDATE drafts SET execution_ref = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ref), id);
}

export function advanceDraftStage(id: number): void {
  db.prepare("UPDATE drafts SET stage = stage + 1, status = 'ready', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function completeDraft(id: number, resultRef: unknown): void {
  db.prepare("UPDATE drafts SET status = 'completed', result_ref = ?, updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(resultRef),
    id
  );
}

export function discardDraft(id: number): void {
  db.prepare("UPDATE drafts SET status = 'discarded', updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?").run(id);
}

export function supersedeDraft(id: number, byDraftId: number): void {
  db.prepare("UPDATE drafts SET superseded_by_draft_id = ?, updated_at = datetime('now') WHERE id = ?").run(byDraftId, id);
}

function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Computes turn as MAX(turn)+1 for the draft in the same synchronous call — better-sqlite3 is single-threaded/synchronous so this is race-free without a transaction. */
export function appendDraftRevision(params: { draftId: number; role: DraftRevisionRole; kind: DraftRevisionKind; text?: string; content?: unknown }): DraftRevision {
  const turnRow = db.prepare('SELECT COALESCE(MAX(turn), 0) AS maxTurn FROM draft_revisions WHERE draft_id = ?').get(params.draftId) as { maxTurn: number };
  const turn = turnRow.maxTurn + 1;
  let content = params.content;
  if (content !== undefined && estimateBytes(content) > MAX_REVISION_CONTENT_BYTES) {
    content = { truncated: true, bytes: estimateBytes(content) };
  }
  const result = db
    .prepare(
      `INSERT INTO draft_revisions (draft_id, turn, role, kind, text, content)
       VALUES (@draftId, @turn, @role, @kind, @text, @content)`
    )
    .run({
      draftId: params.draftId,
      turn,
      role: params.role,
      kind: params.kind,
      text: params.text ?? null,
      content: content !== undefined ? JSON.stringify(content) : null,
    });
  const row = db.prepare('SELECT * FROM draft_revisions WHERE id = ?').get(result.lastInsertRowid as number) as any;
  return mapRevision(row);
}

export function getDraftRevisions(draftId: number): DraftRevision[] {
  const rows = db.prepare('SELECT * FROM draft_revisions WHERE draft_id = ? ORDER BY turn ASC').all(draftId) as any[];
  return rows.map(mapRevision);
}

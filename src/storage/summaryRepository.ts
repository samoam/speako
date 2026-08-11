import { db } from './db';

export interface Summary {
  sessionId: string;
  overview: string;
  keyDecisions: string;
  discussionTopics: string;
  nextSteps: string;
  topics: string[];
  generatedAt: string;
  modelUsed: string;
}

export interface ActionItem {
  id: number;
  sessionId: string;
  owner: string | null;
  description: string;
  dueDate: string | null;
  status: 'open' | 'done';
  confidence: 'explicit' | 'inferred';
}

export type NewActionItem = Omit<ActionItem, 'id' | 'sessionId' | 'status'>;

const upsertSummaryStmt = db.prepare(`
  INSERT INTO summaries (session_id, overview, key_decisions, discussion_topics, next_steps, topics, generated_at, model_used)
  VALUES (@sessionId, @overview, @keyDecisions, @discussionTopics, @nextSteps, @topics, datetime('now'), @modelUsed)
  ON CONFLICT(session_id) DO UPDATE SET
    overview = excluded.overview,
    key_decisions = excluded.key_decisions,
    discussion_topics = excluded.discussion_topics,
    next_steps = excluded.next_steps,
    topics = excluded.topics,
    generated_at = excluded.generated_at,
    model_used = excluded.model_used
`);

const insertActionItemStmt = db.prepare(`
  INSERT INTO action_items (session_id, owner, description, due_date, status, confidence)
  VALUES (@sessionId, @owner, @description, @dueDate, 'open', @confidence)
`);

/** Regenerating a summary replaces the previous one and its action items atomically. */
export const saveSummaryAndActionItems = db.transaction(
  (sessionId: string, summary: Omit<Summary, 'sessionId' | 'generatedAt'>, actionItems: NewActionItem[]) => {
    upsertSummaryStmt.run({
      sessionId,
      overview: summary.overview,
      keyDecisions: summary.keyDecisions,
      discussionTopics: summary.discussionTopics,
      nextSteps: summary.nextSteps,
      topics: JSON.stringify(summary.topics),
      modelUsed: summary.modelUsed,
    });
    db.prepare('DELETE FROM action_items WHERE session_id = ?').run(sessionId);
    for (const item of actionItems) {
      insertActionItemStmt.run({
        sessionId,
        owner: item.owner || null,
        description: item.description,
        dueDate: item.dueDate || null,
        confidence: item.confidence,
      });
    }
  }
);

export function getSummary(sessionId: string): Summary | undefined {
  const row = db.prepare('SELECT * FROM summaries WHERE session_id = ?').get(sessionId) as any;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    overview: row.overview,
    keyDecisions: row.key_decisions,
    discussionTopics: row.discussion_topics,
    nextSteps: row.next_steps,
    topics: JSON.parse(row.topics ?? '[]'),
    generatedAt: row.generated_at,
    modelUsed: row.model_used,
  };
}

export function getActionItems(sessionId: string): ActionItem[] {
  const rows = db.prepare('SELECT * FROM action_items WHERE session_id = ? ORDER BY id ASC').all(sessionId) as any[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    owner: r.owner,
    description: r.description,
    dueDate: r.due_date,
    status: r.status,
    confidence: r.confidence,
  }));
}

export function getActionItem(id: number): ActionItem | undefined {
  const row = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    sessionId: row.session_id,
    owner: row.owner,
    description: row.description,
    dueDate: row.due_date,
    status: row.status,
    confidence: row.confidence,
  };
}

export function setActionItemStatus(id: number, status: 'open' | 'done'): void {
  db.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
}

/** Open action items owned by a given person, across all past sessions — used by the one-on-one prep workflow to surface outstanding commitments with them. Case-insensitive substring match since owner names are free text, not a normalized person id. */
export function getOpenActionItemsByOwner(ownerNameContains: string): ActionItem[] {
  const rows = db
    .prepare("SELECT * FROM action_items WHERE status = 'open' AND owner LIKE ? ORDER BY id DESC LIMIT 20")
    .all(`%${ownerNameContains}%`) as any[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    owner: r.owner,
    description: r.description,
    dueDate: r.due_date,
    status: r.status,
    confidence: r.confidence,
  }));
}

export interface SessionTopics {
  sessionId: string;
  name: string | null;
  startedAt: string;
  topics: string[];
}

/** Every session that has a saved summary, with its topic tags and enough session metadata to display/order them — used by src/insights/topicTrend.ts to aggregate topic frequency across all meetings. */
export function getSessionsWithTopics(): SessionTopics[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.started_at, su.topics
       FROM summaries su
       JOIN sessions s ON s.id = su.session_id
       ORDER BY s.started_at ASC`
    )
    .all() as { id: string; name: string | null; started_at: string; topics: string }[];
  return rows.map((r) => ({ sessionId: r.id, name: r.name, startedAt: r.started_at, topics: JSON.parse(r.topics ?? '[]') }));
}

export function deleteSummaryAndActionItems(sessionId: string): void {
  db.prepare('DELETE FROM action_items WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
}

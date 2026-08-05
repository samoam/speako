import { db } from './db';

export interface Summary {
  sessionId: string;
  overview: string;
  keyDecisions: string;
  discussionTopics: string;
  nextSteps: string;
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
  INSERT INTO summaries (session_id, overview, key_decisions, discussion_topics, next_steps, generated_at, model_used)
  VALUES (@sessionId, @overview, @keyDecisions, @discussionTopics, @nextSteps, datetime('now'), @modelUsed)
  ON CONFLICT(session_id) DO UPDATE SET
    overview = excluded.overview,
    key_decisions = excluded.key_decisions,
    discussion_topics = excluded.discussion_topics,
    next_steps = excluded.next_steps,
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

export function deleteSummaryAndActionItems(sessionId: string): void {
  db.prepare('DELETE FROM action_items WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
}

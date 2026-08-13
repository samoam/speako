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

/**
 * What kind of follow-up this is, driving which one-click action (if any)
 * the Action Items tab offers: 'code_change' reuses the existing
 * "Implement with Claude Code" flow; 'email'/'jira'/'confluence'/
 * 'schedule_meeting'/'teams_message' each open a prefilled deep link into
 * the relevant external tool (no auto-send/auto-create — the user still
 * reviews and submits there); 'reminder' schedules a local browser
 * notification; 'todo'/'general' are plain categorization with no action.
 */
export type ActionItemType =
  | 'general'
  | 'code_change'
  | 'email'
  | 'jira'
  | 'confluence'
  | 'reminder'
  | 'todo'
  | 'schedule_meeting'
  | 'teams_message';

export const ACTION_ITEM_TYPES: ActionItemType[] = [
  'general',
  'code_change',
  'email',
  'jira',
  'confluence',
  'reminder',
  'todo',
  'schedule_meeting',
  'teams_message',
];

/** Set once a jira/confluence action item's real create/update call actually succeeds — see runActionItemAction() in index.html and the /api/action-items/:id/jira|confluence routes. */
export interface ActionItemExternalRef {
  tool: 'jira' | 'confluence';
  action: 'created' | 'updated';
  key: string;
  url: string;
  at: string;
}

export interface ActionItem {
  id: number;
  sessionId: string;
  owner: string | null;
  description: string;
  dueDate: string | null;
  status: 'open' | 'done';
  confidence: 'explicit' | 'inferred' | 'manual';
  type: ActionItemType;
  externalRef: ActionItemExternalRef | null;
}

export type NewActionItem = Omit<ActionItem, 'id' | 'sessionId' | 'status' | 'type' | 'externalRef'> & { type?: ActionItemType };

function mapActionItemRow(r: any): ActionItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    owner: r.owner,
    description: r.description,
    dueDate: r.due_date,
    status: r.status,
    confidence: r.confidence,
    type: r.type,
    externalRef: r.external_ref ? JSON.parse(r.external_ref) : null,
  };
}

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
  INSERT INTO action_items (session_id, owner, description, due_date, status, confidence, type)
  VALUES (@sessionId, @owner, @description, @dueDate, 'open', @confidence, @type)
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
    // Manually-added items (confidence: 'manual') are the user's own input,
    // not something the model produced — regenerating the AI summary
    // replaces only what the model previously extracted, never what the
    // user typed in themselves.
    db.prepare("DELETE FROM action_items WHERE session_id = ? AND confidence != 'manual'").run(sessionId);
    for (const item of actionItems) {
      insertActionItemStmt.run({
        sessionId,
        owner: item.owner || null,
        description: item.description,
        dueDate: item.dueDate || null,
        confidence: item.confidence,
        type: item.type || 'general',
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
  return rows.map(mapActionItemRow);
}

export function getActionItem(id: number): ActionItem | undefined {
  const row = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as any;
  return row ? mapActionItemRow(row) : undefined;
}

export function setActionItemStatus(id: number, status: 'open' | 'done'): void {
  db.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
}

export function setActionItemType(id: number, type: ActionItemType): void {
  db.prepare('UPDATE action_items SET type = ? WHERE id = ?').run(type, id);
}

export function setActionItemExternalRef(id: number, ref: ActionItemExternalRef): void {
  db.prepare('UPDATE action_items SET external_ref = ? WHERE id = ?').run(JSON.stringify(ref), id);
}

/**
 * Candidates for the server-side reminder check (InterfaceServer.
 * checkReminders()) — every 'reminder'-type item with a due date that
 * hasn't fired yet, regardless of whether it's actually due "now." The
 * caller does the real due-time comparison (dueDate + 9am local, same rule
 * the old client-only implementation used) since that's a plain JS Date
 * computation, not something worth expressing in SQL.
 */
export function getUnnotifiedReminders(): ActionItem[] {
  const rows = db
    .prepare("SELECT * FROM action_items WHERE type = 'reminder' AND status = 'open' AND reminder_notified_at IS NULL AND due_date IS NOT NULL")
    .all() as any[];
  return rows.map(mapActionItemRow);
}

export function markReminderNotified(id: number): void {
  db.prepare("UPDATE action_items SET reminder_notified_at = datetime('now') WHERE id = ?").run(id);
}

/** User-entered action items, independent of (and never overwritten by) whatever the AI summary extracts — see saveSummaryAndActionItems' confidence filter. */
export function insertManualActionItem(
  sessionId: string,
  item: { owner?: string | null; description: string; dueDate?: string | null; type?: ActionItemType }
): ActionItem {
  const result = insertActionItemStmt.run({
    sessionId,
    owner: item.owner || null,
    description: item.description,
    dueDate: item.dueDate || null,
    confidence: 'manual',
    type: item.type || 'general',
  });
  return getActionItem(Number(result.lastInsertRowid))!;
}

export function deleteActionItem(id: number): void {
  db.prepare('DELETE FROM action_items WHERE id = ?').run(id);
}

/** Open action items owned by a given person, across all past sessions — used by the one-on-one prep workflow to surface outstanding commitments with them. Case-insensitive substring match since owner names are free text, not a normalized person id. */
export function getOpenActionItemsByOwner(ownerNameContains: string): ActionItem[] {
  const rows = db
    .prepare("SELECT * FROM action_items WHERE status = 'open' AND owner LIKE ? ORDER BY id DESC LIMIT 20")
    .all(`%${ownerNameContains}%`) as any[];
  return rows.map(mapActionItemRow);
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

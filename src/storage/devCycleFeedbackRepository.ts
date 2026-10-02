import { db } from './db';

export type FeedbackStatus = 'open' | 'triaged' | 'answered';
export type FeedbackAction = 'change' | 'answer';

export interface DevCycleFeedback {
  id: number;
  devCycleId: number;
  rootCommentId: number;
  author: string;
  /** The thread's text: the root comment plus the reviewer's follow-ups, newest last. */
  text: string;
  anchorPath: string | null;
  anchorLine: number | null;
  round: number;
  status: FeedbackStatus;
  action: FeedbackAction | null;
  reply: string | null;
  changeInstruction: string | null;
  replyCommentId: number | null;
  resolved: boolean;
  createdAt: string;
  handledAt: string | null;
}

function mapRow(row: any): DevCycleFeedback {
  return {
    id: row.id,
    devCycleId: row.dev_cycle_id,
    rootCommentId: row.root_comment_id,
    author: row.author,
    text: row.text,
    anchorPath: row.anchor_path,
    anchorLine: row.anchor_line,
    round: row.round,
    status: row.status,
    action: row.action,
    reply: row.reply,
    changeInstruction: row.change_instruction,
    replyCommentId: row.reply_comment_id,
    resolved: !!row.resolved,
    createdAt: row.created_at,
    handledAt: row.handled_at,
  };
}

export interface FeedbackThreadInput {
  rootCommentId: number;
  author: string;
  text: string;
  anchorPath: string | null;
  anchorLine: number | null;
}

/**
 * Records the threads that need a response in this round. A thread already
 * answered that the reviewer followed up on comes back as 'open' with the
 * new text (same row — the root comment id is the thread's identity), so
 * the loop answers the follow-up rather than treating it as handled.
 */
export function upsertFeedbackThreads(devCycleId: number, threads: FeedbackThreadInput[], round: number): DevCycleFeedback[] {
  const insert = db.prepare(
    `INSERT INTO dev_cycle_feedback (dev_cycle_id, root_comment_id, author, text, anchor_path, anchor_line, round)
     VALUES (@devCycleId, @rootCommentId, @author, @text, @anchorPath, @anchorLine, @round)
     ON CONFLICT(dev_cycle_id, root_comment_id) DO UPDATE SET
       text = excluded.text, round = excluded.round, status = 'open', action = NULL, reply = NULL, change_instruction = NULL, handled_at = NULL
     WHERE dev_cycle_feedback.text <> excluded.text`
  );
  const tx = db.transaction((items: FeedbackThreadInput[]) => {
    for (const t of items) insert.run({ devCycleId, round, ...t });
  });
  tx(threads);
  return getFeedbackForCycle(devCycleId);
}

export function getFeedbackForCycle(devCycleId: number): DevCycleFeedback[] {
  const rows = db.prepare('SELECT * FROM dev_cycle_feedback WHERE dev_cycle_id = ? ORDER BY id').all(devCycleId) as any[];
  return rows.map(mapRow);
}

/** Threads still waiting for a reply (open or triaged but not yet posted). */
export function getPendingFeedback(devCycleId: number): DevCycleFeedback[] {
  const rows = db.prepare("SELECT * FROM dev_cycle_feedback WHERE dev_cycle_id = ? AND status <> 'answered' ORDER BY id").all(devCycleId) as any[];
  return rows.map(mapRow);
}

export function setFeedbackTriage(id: number, triage: { action: FeedbackAction; reply: string; changeInstruction: string | null }): void {
  db.prepare("UPDATE dev_cycle_feedback SET status = 'triaged', action = ?, reply = ?, change_instruction = ? WHERE id = ?").run(triage.action, triage.reply, triage.changeInstruction, id);
}

/** A human edit of the proposed reply before approval. */
export function setFeedbackReply(id: number, reply: string): void {
  db.prepare('UPDATE dev_cycle_feedback SET reply = ? WHERE id = ?').run(reply, id);
}

export function markFeedbackAnswered(id: number, replyCommentId: number | null, resolved: boolean): void {
  db.prepare("UPDATE dev_cycle_feedback SET status = 'answered', reply_comment_id = ?, resolved = ?, handled_at = datetime('now') WHERE id = ?").run(replyCommentId, resolved ? 1 : 0, id);
}

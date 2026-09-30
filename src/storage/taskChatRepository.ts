import { db } from './db';

export type TaskChatRole = 'user' | 'assistant';

export interface TaskChatMessage {
  id: number;
  taskId: number;
  turn: number;
  role: TaskChatRole;
  text: string;
  createdAt: string;
}

function mapRow(r: any): TaskChatMessage {
  return {
    id: r.id,
    taskId: r.task_id,
    turn: r.turn,
    role: r.role,
    text: r.text,
    createdAt: r.created_at,
  };
}

/** Computes turn as MAX(turn)+1 for the task in the same synchronous call — better-sqlite3 is single-threaded/synchronous so this is race-free without a transaction, same idiom as draftRepository.ts's appendDraftRevision. */
export function appendTaskChatMessage(taskId: number, role: TaskChatRole, text: string): TaskChatMessage {
  const turnRow = db.prepare('SELECT COALESCE(MAX(turn), 0) AS maxTurn FROM task_chat_messages WHERE task_id = ?').get(taskId) as { maxTurn: number };
  const turn = turnRow.maxTurn + 1;
  const result = db
    .prepare('INSERT INTO task_chat_messages (task_id, turn, role, text) VALUES (@taskId, @turn, @role, @text)')
    .run({ taskId, turn, role, text });
  const row = db.prepare('SELECT * FROM task_chat_messages WHERE id = ?').get(result.lastInsertRowid as number) as any;
  return mapRow(row);
}

export function getTaskChatMessages(taskId: number): TaskChatMessage[] {
  const rows = db.prepare('SELECT * FROM task_chat_messages WHERE task_id = ? ORDER BY turn ASC').all(taskId) as any[];
  return rows.map(mapRow);
}

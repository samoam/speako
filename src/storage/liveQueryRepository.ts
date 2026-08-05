import { db } from './db';

export interface LiveQuery {
  id: number;
  sessionId: string;
  questionText: string;
  answerText: string | null;
  sourcesUsed: string[];
  askedAt: string;
}

const insertStmt = db.prepare(`
  INSERT INTO live_queries (session_id, question_text, answer_text, sources_used)
  VALUES (@sessionId, @questionText, @answerText, @sourcesUsed)
`);

function mapRow(r: any): LiveQuery {
  return {
    id: r.id,
    sessionId: r.session_id,
    questionText: r.question_text,
    answerText: r.answer_text,
    sourcesUsed: r.sources_used ? JSON.parse(r.sources_used) : [],
    askedAt: r.asked_at,
  };
}

export function insertLiveQuery(row: { sessionId: string; questionText: string; answerText: string | null; sourcesUsed: string[] }): LiveQuery {
  const info = insertStmt.run({
    sessionId: row.sessionId,
    questionText: row.questionText,
    answerText: row.answerText,
    sourcesUsed: JSON.stringify(row.sourcesUsed),
  });
  return getLiveQuery(Number(info.lastInsertRowid))!;
}

export function getLiveQuery(id: number): LiveQuery | undefined {
  const row = db.prepare('SELECT * FROM live_queries WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function getLiveQueriesForSession(sessionId: string): LiveQuery[] {
  const rows = db.prepare('SELECT * FROM live_queries WHERE session_id = ? ORDER BY asked_at ASC').all(sessionId) as any[];
  return rows.map(mapRow);
}

export function deleteLiveQueriesForSession(sessionId: string): void {
  db.prepare('DELETE FROM live_queries WHERE session_id = ?').run(sessionId);
}

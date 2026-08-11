import { db } from './db';

export interface CrossSessionQuery {
  id: number;
  questionText: string;
  answerText: string;
  sourcesUsed: string[];
  askedAt: string;
}

const insertStmt = db.prepare(
  `INSERT INTO cross_session_queries (question_text, answer_text, sources_used)
   VALUES (@questionText, @answerText, @sourcesUsed)`
);

/** Not session-scoped — "ask across all my meetings" has no single session to attach the question to. */
export function insertCrossSessionQuery(query: Omit<CrossSessionQuery, 'id' | 'askedAt'>): CrossSessionQuery {
  const result = insertStmt.run({
    questionText: query.questionText,
    answerText: query.answerText,
    sourcesUsed: JSON.stringify(query.sourcesUsed),
  });
  const row = db.prepare('SELECT * FROM cross_session_queries WHERE id = ?').get(result.lastInsertRowid) as {
    id: number;
    question_text: string;
    answer_text: string;
    sources_used: string;
    asked_at: string;
  };
  return {
    id: row.id,
    questionText: row.question_text,
    answerText: row.answer_text,
    sourcesUsed: JSON.parse(row.sources_used),
    askedAt: row.asked_at,
  };
}

export function getCrossSessionQueryHistory(limit = 50): CrossSessionQuery[] {
  const rows = db.prepare('SELECT * FROM cross_session_queries ORDER BY id DESC LIMIT ?').all(limit) as {
    id: number;
    question_text: string;
    answer_text: string;
    sources_used: string;
    asked_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    questionText: r.question_text,
    answerText: r.answer_text,
    sourcesUsed: JSON.parse(r.sources_used),
    askedAt: r.asked_at,
  }));
}

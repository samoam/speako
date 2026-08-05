import { db } from './db';

export interface SentimentScore {
  id: number;
  sessionId: string;
  speaker: string;
  startMs: number;
  endMs: number;
  score: number;
  magnitude: number;
}

const insertStmt = db.prepare(`
  INSERT INTO sentiment_scores (session_id, speaker, start_ms, end_ms, score, magnitude)
  VALUES (@sessionId, @speaker, @startMs, @endMs, @score, @magnitude)
`);

export function insertSentimentScore(row: Omit<SentimentScore, 'id'>): void {
  insertStmt.run({
    sessionId: row.sessionId,
    speaker: row.speaker,
    startMs: Math.round(row.startMs),
    endMs: Math.round(row.endMs),
    score: row.score,
    magnitude: row.magnitude,
  });
}

export function getSentimentScoresForSession(sessionId: string): SentimentScore[] {
  const rows = db
    .prepare('SELECT * FROM sentiment_scores WHERE session_id = ? ORDER BY start_ms ASC')
    .all(sessionId) as any[];

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    speaker: r.speaker,
    startMs: r.start_ms,
    endMs: r.end_ms,
    score: r.score,
    magnitude: r.magnitude,
  }));
}

export function deleteSentimentScoresForSession(sessionId: string): void {
  db.prepare('DELETE FROM sentiment_scores WHERE session_id = ?').run(sessionId);
}

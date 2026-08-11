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

export interface SessionSentimentAverage {
  sessionId: string;
  avgScore: number;
  scoreCount: number;
}

/** One grouped query across every session in a series, rather than one query per session — used by src/insights/relationshipTrend.ts. Sessions with no sentiment rows (feature disabled, or no config.geminiApiKey at the time) are simply absent from the result, not zeroed. */
export function getAverageSentimentPerSession(sessionIds: string[]): SessionSentimentAverage[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT session_id, AVG(score) AS avg_score, COUNT(*) AS score_count
       FROM sentiment_scores
       WHERE session_id IN (${placeholders})
       GROUP BY session_id`
    )
    .all(...sessionIds) as { session_id: string; avg_score: number; score_count: number }[];
  return rows.map((r) => ({ sessionId: r.session_id, avgScore: r.avg_score, scoreCount: r.score_count }));
}

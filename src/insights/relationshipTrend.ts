import { getSession, findSessionSeries } from '../storage/segmentRepository';
import { getAverageSentimentPerSession } from '../storage/sentimentRepository';

export interface RelationshipTrendPoint {
  sessionId: string;
  name: string | null;
  startedAt: string;
  avgScore: number | null;
  scoreCount: number;
}

/**
 * Chronological sentiment trend across every session in a recurring 1:1
 * series (including whichever one the caller is currently viewing) — deterministic,
 * no Gemini call, purely aggregating sentiment_scores already recorded live.
 * Returns [] for anything that isn't a one_on_one session, or one with no
 * name to identify the series by (see findSessionSeries).
 */
export function getRelationshipTrend(sessionId: string): RelationshipTrendPoint[] {
  const session = getSession(sessionId);
  if (!session || session.meetingType !== 'one_on_one') return [];

  const series = findSessionSeries(session.meetingType, session.name ?? undefined);
  if (series.length === 0) return [];

  const averages = getAverageSentimentPerSession(series.map((s) => s.id));
  const bySessionId = new Map(averages.map((a) => [a.sessionId, a]));

  return series.map((s) => {
    const avg = bySessionId.get(s.id);
    return { sessionId: s.id, name: s.name, startedAt: s.startedAt, avgScore: avg?.avgScore ?? null, scoreCount: avg?.scoreCount ?? 0 };
  });
}

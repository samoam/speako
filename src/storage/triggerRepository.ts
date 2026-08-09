import { db } from './db';

export type TriggerCategory =
  | 'factual_claim'
  | 'decision_point'
  | 'vagueness'
  | 'tone_shift'
  | 'unanswered_question'
  | 'anticipated_answer';

export interface TriggerEvent {
  id: number;
  sessionId: string;
  category: TriggerCategory;
  confidence: number;
  reason: string;
  startMs: number;
  endMs: number;
  /** The actual transcript text the trigger fired on — what fact-checking/live-Q&A actually operate on, and what's edited when fixing a transcription typo before rechecking. Null for triggers persisted before this field existed. */
  segmentText: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO triggers (session_id, category, confidence, reason, start_ms, end_ms, segment_text)
  VALUES (@sessionId, @category, @confidence, @reason, @startMs, @endMs, @segmentText)
`);

function mapRow(r: any): TriggerEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    category: r.category,
    confidence: r.confidence,
    reason: r.reason,
    startMs: r.start_ms,
    endMs: r.end_ms,
    segmentText: r.segment_text ?? null,
  };
}

export function insertTrigger(row: Omit<TriggerEvent, 'id'>): number {
  const info = insertStmt.run({
    sessionId: row.sessionId,
    category: row.category,
    confidence: row.confidence,
    reason: row.reason,
    startMs: Math.round(row.startMs),
    endMs: Math.round(row.endMs),
    segmentText: row.segmentText,
  });
  return Number(info.lastInsertRowid);
}

export function getTrigger(id: number): TriggerEvent | undefined {
  const row = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function getTriggersForSession(sessionId: string): TriggerEvent[] {
  const rows = db.prepare('SELECT * FROM triggers WHERE session_id = ? ORDER BY start_ms ASC').all(sessionId) as any[];
  return rows.map(mapRow);
}

/** Overwrites the claim text a trigger is checked against — used when the user fixes a transcription typo before requesting a recheck. */
export function updateTriggerSegmentText(id: number, segmentText: string): void {
  db.prepare('UPDATE triggers SET segment_text = ? WHERE id = ?').run(segmentText, id);
}

export function deleteTriggersForSession(sessionId: string): void {
  db.prepare('DELETE FROM triggers WHERE session_id = ?').run(sessionId);
}

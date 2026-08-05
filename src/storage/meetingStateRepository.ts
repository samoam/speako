import { db } from './db';

export interface OpenItem {
  /** Short stable slug invented by the model on first mention — kept across updates so the same item isn't re-added as a duplicate. */
  id: string;
  description: string;
  category: 'question' | 'commitment' | 'flagged_claim';
}

export interface MeetingState {
  sessionId: string;
  rollingSummary: string;
  openItems: OpenItem[];
  lastUpdatedSegmentCount: number;
  updatedAt: string;
}

function mapRow(r: any): MeetingState {
  return {
    sessionId: r.session_id,
    rollingSummary: r.rolling_summary,
    openItems: JSON.parse(r.open_items || '[]'),
    lastUpdatedSegmentCount: r.last_updated_segment_count,
    updatedAt: r.updated_at,
  };
}

export function getMeetingState(sessionId: string): MeetingState | undefined {
  const row = db.prepare('SELECT * FROM meeting_state WHERE session_id = ?').get(sessionId) as any;
  return row ? mapRow(row) : undefined;
}

const upsertStmt = db.prepare(`
  INSERT INTO meeting_state (session_id, rolling_summary, open_items, last_updated_segment_count, updated_at)
  VALUES (@sessionId, @rollingSummary, @openItems, @lastUpdatedSegmentCount, datetime('now'))
  ON CONFLICT(session_id) DO UPDATE SET
    rolling_summary = excluded.rolling_summary,
    open_items = excluded.open_items,
    last_updated_segment_count = excluded.last_updated_segment_count,
    updated_at = excluded.updated_at
`);

export function upsertMeetingState(
  sessionId: string,
  rollingSummary: string,
  openItems: OpenItem[],
  lastUpdatedSegmentCount: number
): void {
  upsertStmt.run({
    sessionId,
    rollingSummary,
    openItems: JSON.stringify(openItems),
    lastUpdatedSegmentCount,
  });
}

export function deleteMeetingStateForSession(sessionId: string): void {
  db.prepare('DELETE FROM meeting_state WHERE session_id = ?').run(sessionId);
}

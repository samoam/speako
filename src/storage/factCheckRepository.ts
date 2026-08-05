import { db } from './db';

export type FactCheckResult = 'match' | 'conflict' | 'insufficient';
export type FactCheckAction = 'accepted' | 'dismissed' | 'ignored';

export interface FactCheck {
  id: number;
  sessionId: string;
  triggerId: number | null;
  claimText: string;
  sourceQueried: string;
  groundTruth: string | null;
  result: FactCheckResult;
  surfaced: boolean;
  userAction: FactCheckAction;
  createdAt: string;
}

const insertStmt = db.prepare(`
  INSERT INTO fact_checks (session_id, trigger_id, claim_text, source_queried, ground_truth, result, surfaced)
  VALUES (@sessionId, @triggerId, @claimText, @sourceQueried, @groundTruth, @result, @surfaced)
`);

function mapRow(r: any): FactCheck {
  return {
    id: r.id,
    sessionId: r.session_id,
    triggerId: r.trigger_id,
    claimText: r.claim_text,
    sourceQueried: r.source_queried,
    groundTruth: r.ground_truth,
    result: r.result,
    surfaced: !!r.surfaced,
    userAction: r.user_action,
    createdAt: r.created_at,
  };
}

/** Only `surfaced:true` rows (conflicts) are meant to reach the UI — matches/insufficient are logged for later analysis, not shown. */
export function insertFactCheck(row: Omit<FactCheck, 'id' | 'userAction' | 'createdAt'>): FactCheck {
  const info = insertStmt.run({
    sessionId: row.sessionId,
    triggerId: row.triggerId,
    claimText: row.claimText,
    sourceQueried: row.sourceQueried,
    groundTruth: row.groundTruth,
    result: row.result,
    surfaced: row.surfaced ? 1 : 0,
  });
  return getFactCheck(Number(info.lastInsertRowid))!;
}

export function getFactCheck(id: number): FactCheck | undefined {
  const row = db.prepare('SELECT * FROM fact_checks WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function getSurfacedFactChecksForSession(sessionId: string): FactCheck[] {
  const rows = db
    .prepare('SELECT * FROM fact_checks WHERE session_id = ? AND surfaced = 1 ORDER BY created_at ASC')
    .all(sessionId) as any[];
  return rows.map(mapRow);
}

/** All fact-checks for a session (not just surfaced conflicts) — used to show check status inline on the Triggers tab. */
export function getFactChecksForSession(sessionId: string): FactCheck[] {
  const rows = db.prepare('SELECT * FROM fact_checks WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];
  return rows.map(mapRow);
}

export function setFactCheckAction(id: number, action: 'accepted' | 'dismissed'): void {
  db.prepare('UPDATE fact_checks SET user_action = ? WHERE id = ?').run(action, id);
}

export function deleteFactChecksForSession(sessionId: string): void {
  db.prepare('DELETE FROM fact_checks WHERE session_id = ?').run(sessionId);
}

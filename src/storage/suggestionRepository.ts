import { db } from './db';

export type SuggestionAction = 'accepted' | 'dismissed' | 'ignored';

export interface Suggestion {
  id: number;
  sessionId: string;
  triggerId: number | null;
  triggerCategory: string;
  suggestionText: string;
  sourceCitation: string | null;
  confidence: number;
  userAction: SuggestionAction;
  createdAt: string;
}

const insertStmt = db.prepare(`
  INSERT INTO suggestions (session_id, trigger_id, trigger_category, suggestion_text, source_citation, confidence)
  VALUES (@sessionId, @triggerId, @triggerCategory, @suggestionText, @sourceCitation, @confidence)
`);

export function insertSuggestion(row: Omit<Suggestion, 'id' | 'userAction' | 'createdAt'>): Suggestion {
  const info = insertStmt.run({
    sessionId: row.sessionId,
    triggerId: row.triggerId,
    triggerCategory: row.triggerCategory,
    suggestionText: row.suggestionText,
    sourceCitation: row.sourceCitation,
    confidence: row.confidence,
  });
  return getSuggestion(Number(info.lastInsertRowid))!;
}

function mapRow(r: any): Suggestion {
  return {
    id: r.id,
    sessionId: r.session_id,
    triggerId: r.trigger_id,
    triggerCategory: r.trigger_category,
    suggestionText: r.suggestion_text,
    sourceCitation: r.source_citation,
    confidence: r.confidence,
    userAction: r.user_action,
    createdAt: r.created_at,
  };
}

export function getSuggestionsForSession(sessionId: string): Suggestion[] {
  const rows = db.prepare('SELECT * FROM suggestions WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];
  return rows.map(mapRow);
}

export function getSuggestion(id: number): Suggestion | undefined {
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function setSuggestionAction(id: number, action: 'accepted' | 'dismissed'): void {
  db.prepare('UPDATE suggestions SET user_action = ? WHERE id = ?').run(action, id);
}

export function deleteSuggestionsForSession(sessionId: string): void {
  db.prepare('DELETE FROM suggestions WHERE session_id = ?').run(sessionId);
}

import { randomUUID } from 'crypto';
import { db } from './db';
import type { AnticipatedQA } from '../prep/anticipateQA';

export interface PrepBrief {
  id: string;
  sessionId: string;
  meetingType: string;
  calendarEventId: string | null;
  sourcesQueried: string[];
  prepBriefText: string;
  rawContext: unknown;
  anticipatedQa: AnticipatedQA | null;
  generatedAt: string;
}

export function createPrepBrief(params: {
  sessionId: string;
  meetingType: string;
  calendarEventId?: string | null;
  sourcesQueried: string[];
  prepBriefText: string;
  rawContext: unknown;
  anticipatedQa?: AnticipatedQA | null;
}): PrepBrief {
  const id = randomUUID();
  const generatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO prep_briefs (id, session_id, meeting_type, calendar_event_id, sources_queried, prep_brief_text, raw_context, anticipated_qa, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.sessionId,
    params.meetingType,
    params.calendarEventId || null,
    JSON.stringify(params.sourcesQueried),
    params.prepBriefText,
    JSON.stringify(params.rawContext),
    params.anticipatedQa ? JSON.stringify(params.anticipatedQa) : null,
    generatedAt
  );
  return {
    id,
    sessionId: params.sessionId,
    meetingType: params.meetingType,
    calendarEventId: params.calendarEventId || null,
    sourcesQueried: params.sourcesQueried,
    prepBriefText: params.prepBriefText,
    rawContext: params.rawContext,
    anticipatedQa: params.anticipatedQa || null,
    generatedAt,
  };
}

export function getPrepBrief(sessionId: string): PrepBrief | undefined {
  const row = db.prepare('SELECT * FROM prep_briefs WHERE session_id = ?').get(sessionId) as
    | {
        id: string;
        session_id: string;
        meeting_type: string;
        calendar_event_id: string | null;
        sources_queried: string;
        prep_brief_text: string;
        raw_context: string;
        anticipated_qa: string | null;
        generated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    sessionId: row.session_id,
    meetingType: row.meeting_type,
    calendarEventId: row.calendar_event_id,
    sourcesQueried: JSON.parse(row.sources_queried),
    prepBriefText: row.prep_brief_text,
    rawContext: JSON.parse(row.raw_context),
    anticipatedQa: row.anticipated_qa ? JSON.parse(row.anticipated_qa) : null,
    generatedAt: row.generated_at,
  };
}

/** User-edited brief text, per the "editable brief" requirement — doesn't touch sourcesQueried/rawContext. */
export function updatePrepBriefText(sessionId: string, text: string): void {
  db.prepare('UPDATE prep_briefs SET prep_brief_text = ? WHERE session_id = ?').run(text, sessionId);
}

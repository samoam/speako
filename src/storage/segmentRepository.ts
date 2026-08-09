import { db } from './db';
import { TranscriptSegment } from '../types';

export interface CreateSessionOptions {
  sessionType?: 'personal' | 'work';
  meetingType?: string;
  calendarEventId?: string;
  /** Which tools/integrations are active for this session (see src/tools/activeTools.ts). Omitted/undefined means "all globally-configured tools" — preserves existing behavior. */
  activeTools?: string[];
}

export function createSession(
  sessionId: string,
  languageCodes: string[],
  name?: string,
  options?: CreateSessionOptions
): void {
  db.prepare(
    `INSERT INTO sessions (id, started_at, language_codes, name, session_type, meeting_type, calendar_event_id, prep_status, active_tools)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    JSON.stringify(languageCodes),
    name || null,
    options?.sessionType || 'personal',
    options?.meetingType || null,
    options?.calendarEventId || null,
    options?.sessionType === 'work' ? 'pending' : 'none',
    options?.activeTools ? JSON.stringify(options.activeTools) : null
  );
}

export function setPrepStatus(sessionId: string, status: 'none' | 'pending' | 'ready' | 'failed'): void {
  db.prepare('UPDATE sessions SET prep_status = ? WHERE id = ?').run(status, sessionId);
}

export function setActiveTools(sessionId: string, tools: string[]): void {
  db.prepare('UPDATE sessions SET active_tools = ? WHERE id = ?').run(JSON.stringify(tools), sessionId);
}

/**
 * Finds the most likely "previous instance" of a recurring work meeting, for
 * prep workflows that want last time's notes (standup, retro, 1:1, etc).
 * Prefers an exact case-insensitive name match among past sessions of the
 * same meeting_type; falls back to the most recent session of that type with
 * any name. Always overridable in the UI — this is a best-effort default,
 * not a guarantee.
 */
export interface PreviousSessionMatch {
  id: string;
  name: string | null;
  endedAt: string | null;
}

export function findLikelyPreviousSession(
  meetingType: string,
  name: string | undefined,
  excludeSessionId: string
): PreviousSessionMatch | undefined {
  const candidates = db
    .prepare(
      `SELECT id, name, ended_at
       FROM sessions
       WHERE session_type = 'work' AND meeting_type = ? AND id != ? AND ended_at IS NOT NULL
       ORDER BY started_at DESC, rowid DESC`
    )
    .all(meetingType, excludeSessionId) as { id: string; name: string | null; ended_at: string | null }[];

  if (candidates.length === 0) return undefined;

  const normalizedName = name?.trim().toLowerCase();
  const exactMatch = normalizedName
    ? candidates.find((c) => c.name?.trim().toLowerCase() === normalizedName)
    : undefined;
  const row = exactMatch || candidates[0];

  return { id: row.id, name: row.name, endedAt: row.ended_at };
}

export function endSession(sessionId: string): void {
  db.prepare('UPDATE sessions SET ended_at = datetime(\'now\') WHERE id = ?').run(sessionId);
}

export function renameSession(sessionId: string, name: string): void {
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name || null, sessionId);
}

/**
 * Recovers sessions left permanently "recording" because the process died
 * before Session.stop() could run — a crash, a forced kill, the machine
 * sleeping/losing power. Session.stop() is the only thing that sets
 * ended_at, and it only runs on a clean stop request or SIGINT/SIGTERM;
 * anything else (including an uncaught exception, if it manages to bypass
 * index.ts's handler) leaves the row stuck with ended_at NULL forever, which
 * locks the session's Identify/Summarize/Analyze-emotion/Delete buttons.
 * Called once at process startup — a fresh process means nothing is actually
 * recording, so any NULL ended_at row at that point is necessarily orphaned.
 * Backdates ended_at to the last segment actually seen (falling back to
 * started_at if there are none) rather than "now", so the recorded duration
 * isn't inflated by however long the row sat abandoned before this restart.
 */
export function closeOrphanedSessions(): number {
  const orphaned = db.prepare('SELECT id FROM sessions WHERE ended_at IS NULL').all() as { id: string }[];
  for (const { id } of orphaned) {
    const lastSegment = db
      .prepare('SELECT created_at FROM transcript_segments WHERE session_id = ? ORDER BY id DESC LIMIT 1')
      .get(id) as { created_at: string } | undefined;
    db.prepare('UPDATE sessions SET ended_at = COALESCE(?, started_at) WHERE id = ?').run(lastSegment?.created_at ?? null, id);
  }
  return orphaned.length;
}

/**
 * Permanently removes a session and everything derived from it.
 * Order matters: suggestions/fact_checks both have trigger_id REFERENCES
 * triggers(id), so they must be deleted before triggers itself, or the FK
 * constraint fails (confirmed — this exact ordering bug crashed the process
 * via an unhandled rejection).
 */
export const deleteSession = db.transaction((sessionId: string) => {
  db.prepare('DELETE FROM transcript_segments WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM action_items WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sentiment_scores WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM corpus_chunks WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM suggestions WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM fact_checks WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM triggers WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM live_queries WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM meeting_state WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM prep_briefs WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM coaching_feedback WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
});

export interface SessionRow {
  id: string;
  languageCodes: string[];
  endedAt: string | null;
  name: string | null;
  sessionType: 'personal' | 'work';
  meetingType: string | null;
  calendarEventId: string | null;
  prepStatus: 'none' | 'pending' | 'ready' | 'failed';
  /** null means "all globally-configured tools active" — see src/tools/activeTools.ts. */
  activeTools: string[] | null;
}

export function getSession(sessionId: string): SessionRow | undefined {
  const row = db
    .prepare(
      `SELECT id, ended_at, language_codes, name, session_type, meeting_type, calendar_event_id, prep_status, active_tools
       FROM sessions WHERE id = ?`
    )
    .get(sessionId) as
    | {
        id: string;
        ended_at: string | null;
        language_codes: string | null;
        name: string | null;
        session_type: 'personal' | 'work';
        meeting_type: string | null;
        calendar_event_id: string | null;
        prep_status: 'none' | 'pending' | 'ready' | 'failed';
        active_tools: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    endedAt: row.ended_at,
    languageCodes: row.language_codes ? JSON.parse(row.language_codes) : ['en-US'],
    name: row.name,
    sessionType: row.session_type,
    meetingType: row.meeting_type,
    calendarEventId: row.calendar_event_id,
    prepStatus: row.prep_status,
    activeTools: row.active_tools ? JSON.parse(row.active_tools) : null,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO transcript_segments (session_id, speaker, start_ms, end_ms, text, is_final)
  VALUES (@sessionId, @speaker, @startMs, @endMs, @text, @isFinal)
`);

/** Only final segments are persisted; interim results are for live display only. */
export function insertFinalSegment(segment: TranscriptSegment): void {
  insertStmt.run({
    sessionId: segment.sessionId,
    speaker: segment.speaker,
    startMs: Math.round(segment.startMs),
    endMs: Math.round(segment.endMs),
    text: segment.text,
    isFinal: 1,
  });
}

/** Atomically swaps a session's channel-based segments for diarized ones, once available. */
export const replaceSegmentsForSession = db.transaction((sessionId: string, segments: TranscriptSegment[]) => {
  db.prepare('DELETE FROM transcript_segments WHERE session_id = ?').run(sessionId);
  for (const segment of segments) insertFinalSegment(segment);
  db.prepare('UPDATE sessions SET diarized_at = datetime(\'now\') WHERE id = ?').run(sessionId);
});

export interface SessionSummary {
  id: string;
  name: string | null;
  startedAt: string;
  endedAt: string | null;
  diarizedAt: string | null;
  languageCodes: string[];
  segmentCount: number;
  hasSummary: boolean;
  sessionType: 'personal' | 'work';
  meetingType: string | null;
  prepStatus: 'none' | 'pending' | 'ready' | 'failed';
  activeTools: string[] | null;
}

export function listSessions(): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.started_at, s.ended_at, s.diarized_at, s.language_codes,
              s.session_type, s.meeting_type, s.prep_status, s.active_tools,
              (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id) AS segment_count,
              (SELECT COUNT(*) FROM summaries u WHERE u.session_id = s.id) AS has_summary
       FROM sessions s
       ORDER BY s.started_at DESC`
    )
    .all() as any[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    diarizedAt: r.diarized_at,
    languageCodes: r.language_codes ? JSON.parse(r.language_codes) : [],
    segmentCount: r.segment_count,
    hasSummary: !!r.has_summary,
    sessionType: r.session_type,
    meetingType: r.meeting_type,
    prepStatus: r.prep_status,
    activeTools: r.active_tools ? JSON.parse(r.active_tools) : null,
  }));
}

export function getSegmentsForSession(sessionId: string): TranscriptSegment[] {
  const rows = db
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY start_ms ASC')
    .all(sessionId) as any[];

  return rows.map((r) => ({
    sessionId: r.session_id,
    speaker: r.speaker,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    isFinal: !!r.is_final,
  }));
}

/** Total finalized segments for a session — used as the meeting-state update cadence's progress marker (see meeting_state.last_updated_segment_count). */
export function countSegmentsForSession(sessionId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id = ?').get(sessionId) as { n: number };
  return row.n;
}

/** Segments beyond the first `offset` (insertion order) — the "new since the last meeting-state update" slice. */
export function getSegmentsForSessionSince(sessionId: string, offset: number): TranscriptSegment[] {
  const rows = db
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY id ASC LIMIT -1 OFFSET ?')
    .all(sessionId, offset) as any[];

  return rows.map((r) => ({
    sessionId: r.session_id,
    speaker: r.speaker,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    isFinal: !!r.is_final,
  }));
}

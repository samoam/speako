import { db } from './db';

export interface AudioOverview {
  id: number;
  sessionId: string | null;
  subjectText: string;
  scriptText: string;
  audioPath: string;
  generatedAt: string;
}

function mapRow(r: any): AudioOverview {
  return {
    id: r.id,
    sessionId: r.session_id,
    subjectText: r.subject_text,
    scriptText: r.script_text,
    audioPath: r.audio_path,
    generatedAt: r.generated_at,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO audio_overviews (session_id, subject_text, script_text, audio_path)
  VALUES (@sessionId, @subjectText, @scriptText, @audioPath)
`);

/** sessionId is null for a subject-driven overview grounded across the whole meeting corpus (see crossSessionQa.ts's identical scoping) — set only when this is "an overview of this specific session." */
export function insertAudioOverview(overview: { sessionId?: string | null; subjectText: string; scriptText: string; audioPath: string }): AudioOverview {
  const result = insertStmt.run({
    sessionId: overview.sessionId ?? null,
    subjectText: overview.subjectText,
    scriptText: overview.scriptText,
    audioPath: overview.audioPath,
  });
  return getAudioOverview(Number(result.lastInsertRowid))!;
}

export function getAudioOverview(id: number): AudioOverview | undefined {
  const row = db.prepare('SELECT * FROM audio_overviews WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** The most recent overview generated specifically for this session, if any — regenerating deletes the old row+file first (server.ts), so there's at most one in practice, but ORDER BY + LIMIT is defensive. */
export function getAudioOverviewForSession(sessionId: string): AudioOverview | undefined {
  const row = db.prepare('SELECT * FROM audio_overviews WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as any;
  return row ? mapRow(row) : undefined;
}

/** Deletes the DB row and returns its audioPath so the caller can remove the file too (this repository never touches the filesystem itself) — used when regenerating a session's overview, so the old file doesn't leak on disk. */
export function deleteAudioOverview(id: number): string | undefined {
  const existing = getAudioOverview(id);
  db.prepare('DELETE FROM audio_overviews WHERE id = ?').run(id);
  return existing?.audioPath;
}

import { db } from './db';
import { Chapter } from '../summarization/chapters';

export interface MeetingChapters {
  sessionId: string;
  chapters: Chapter[];
  generatedAt: string;
}

const upsertStmt = db.prepare(
  `INSERT INTO meeting_chapters (session_id, chapters, generated_at)
   VALUES (@sessionId, @chapters, @generatedAt)
   ON CONFLICT(session_id) DO UPDATE SET
     chapters = excluded.chapters,
     generated_at = excluded.generated_at`
);

/** Compute-once-cache-in-a-row, same shape as coachingRepository.ts — re-running "Detect chapters" overwrites the prior result rather than duplicating. */
export function saveChapters(sessionId: string, chapters: Chapter[]): MeetingChapters {
  const generatedAt = new Date().toISOString();
  upsertStmt.run({ sessionId, chapters: JSON.stringify(chapters), generatedAt });
  return { sessionId, chapters, generatedAt };
}

/** undefined means chapters haven't been generated for this session yet. */
export function getChapters(sessionId: string): MeetingChapters | undefined {
  const row = db.prepare('SELECT * FROM meeting_chapters WHERE session_id = ?').get(sessionId) as
    | { session_id: string; chapters: string; generated_at: string }
    | undefined;
  if (!row) return undefined;
  return { sessionId: row.session_id, chapters: JSON.parse(row.chapters), generatedAt: row.generated_at };
}

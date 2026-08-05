import { db } from './db';

export interface CorpusChunk {
  id: number;
  sessionId: string;
  chunkIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  embedding: number[];
}

const insertStmt = db.prepare(`
  INSERT INTO corpus_chunks (session_id, chunk_index, text, start_ms, end_ms, embedding)
  VALUES (@sessionId, @chunkIndex, @text, @startMs, @endMs, @embedding)
`);

export function insertChunk(chunk: Omit<CorpusChunk, 'id'>): void {
  insertStmt.run({
    sessionId: chunk.sessionId,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    startMs: Math.round(chunk.startMs),
    endMs: Math.round(chunk.endMs),
    embedding: JSON.stringify(chunk.embedding),
  });
}

export interface CorpusChunkWithSessionName extends CorpusChunk {
  sessionName: string | null;
}

/** All indexed chunks except the given session's own — used at retrieval time so a live session never retrieves against itself. */
export function getAllChunksExcludingSession(excludeSessionId: string): CorpusChunkWithSessionName[] {
  const rows = db
    .prepare(
      `SELECT c.*, s.name AS session_name
       FROM corpus_chunks c
       JOIN sessions s ON s.id = c.session_id
       WHERE c.session_id != ?`
    )
    .all(excludeSessionId) as any[];

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    chunkIndex: r.chunk_index,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    embedding: JSON.parse(r.embedding),
    sessionName: r.session_name,
  }));
}

export function deleteChunksForSession(sessionId: string): void {
  db.prepare('DELETE FROM corpus_chunks WHERE session_id = ?').run(sessionId);
}

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

const selectAllStmt = db.prepare(
  `SELECT c.*, s.name AS session_name
   FROM corpus_chunks c
   JOIN sessions s ON s.id = c.session_id`
);

function rowToChunk(r: any): CorpusChunkWithSessionName {
  return {
    id: r.id,
    sessionId: r.session_id,
    chunkIndex: r.chunk_index,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    embedding: JSON.parse(r.embedding),
    sessionName: r.session_name,
  };
}

/** Every indexed chunk across all sessions — callers filter out their own session in-memory (see rag.ts's cache, which keeps this decoded list around across a session's repeated retrieve() calls instead of re-querying/re-parsing every time). */
export function getAllChunks(): CorpusChunkWithSessionName[] {
  return (selectAllStmt.all() as any[]).map(rowToChunk);
}

export function deleteChunksForSession(sessionId: string): void {
  db.prepare('DELETE FROM corpus_chunks WHERE session_id = ?').run(sessionId);
}

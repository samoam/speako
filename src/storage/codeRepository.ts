import { db } from './db';

export interface CodeChunk {
  id: number;
  repoName: string;
  filePath: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

const insertStmt = db.prepare(`
  INSERT INTO code_chunks (repo_name, file_path, chunk_index, text, embedding)
  VALUES (@repoName, @filePath, @chunkIndex, @text, @embedding)
`);

export function insertCodeChunk(chunk: Omit<CodeChunk, 'id'>): void {
  insertStmt.run({
    repoName: chunk.repoName,
    filePath: chunk.filePath,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    embedding: JSON.stringify(chunk.embedding),
  });
}

/** Wipes a repo's chunks before re-indexing — makes runCodebaseIndex's per-repo reindex idempotent, same idea as ingest_repo's replace-on-reingest elsewhere in this project. */
export function deleteChunksForRepo(repoName: string): void {
  db.prepare('DELETE FROM code_chunks WHERE repo_name = ?').run(repoName);
}

export function getAllCodeChunks(): CodeChunk[] {
  const rows = db.prepare('SELECT * FROM code_chunks').all() as any[];
  return rows.map((r) => ({
    id: r.id,
    repoName: r.repo_name,
    filePath: r.file_path,
    chunkIndex: r.chunk_index,
    text: r.text,
    embedding: JSON.parse(r.embedding),
  }));
}

export interface IndexedRepoSummary {
  repoName: string;
  chunkCount: number;
  indexedAt: string;
}

/** For the status endpoint/UI — what's indexed and how current it is, without touching the actual chunk data. */
export function getIndexedRepoSummary(): IndexedRepoSummary[] {
  const rows = db
    .prepare(
      `SELECT repo_name, COUNT(*) AS chunk_count, MAX(indexed_at) AS indexed_at
       FROM code_chunks
       GROUP BY repo_name
       ORDER BY repo_name ASC`
    )
    .all() as any[];
  return rows.map((r) => ({ repoName: r.repo_name, chunkCount: r.chunk_count, indexedAt: r.indexed_at }));
}

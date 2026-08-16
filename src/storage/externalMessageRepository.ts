import { db } from './db';

export type ExternalMessageSource = 'email' | 'teams';

export interface ExternalMessage {
  id: string;
  source: ExternalMessageSource;
  title: string | null;
  participants: string[];
  occurredAt: string;
  bodyText: string;
}

const upsertMessageStmt = db.prepare(`
  INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
  VALUES (@id, @source, @title, @participants, @occurredAt, @bodyText)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    participants = excluded.participants,
    occurred_at = excluded.occurred_at,
    body_text = excluded.body_text,
    indexed_at = NULL
`);

/**
 * Writes a raw message into external_messages — same upsert contract
 * docs/EXTERNAL_INGESTION_PROMPT.md specifies for the external daily-agent
 * task (resetting indexed_at to NULL on update so an edited message gets
 * re-chunked, never on INSERT DO NOTHING which would leave stale chunks).
 * Used by outlookMailSync.ts's Outlook mail ingestion and teamsConnectorSync.ts's Teams ingestion; the external-agent
 * path writes to this same table directly via raw SQL instead of this function.
 */
export function upsertExternalMessage(message: ExternalMessage): void {
  upsertMessageStmt.run({
    id: message.id,
    source: message.source,
    title: message.title,
    participants: JSON.stringify(message.participants),
    occurredAt: message.occurredAt,
    bodyText: message.bodyText,
  });
}

/** For the reply-draft view's conversation context — task.externalRef is the same id as external_messages.id for teams_message/email_message sourced tasks. */
export function getExternalMessageById(id: string): ExternalMessage | undefined {
  const row = db.prepare('SELECT * FROM external_messages WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    participants: row.participants ? JSON.parse(row.participants) : [],
    occurredAt: row.occurred_at,
    bodyText: row.body_text,
  };
}

export function getUnindexedMessages(): ExternalMessage[] {
  const rows = db.prepare('SELECT * FROM external_messages WHERE indexed_at IS NULL').all() as any[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    participants: r.participants ? JSON.parse(r.participants) : [],
    occurredAt: r.occurred_at,
    bodyText: r.body_text,
  }));
}

export function markMessageIndexed(id: string): void {
  db.prepare("UPDATE external_messages SET indexed_at = datetime('now') WHERE id = ?").run(id);
}

export interface ExternalMessageChunk {
  id: number;
  messageId: string;
  source: ExternalMessageSource;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

const insertChunkStmt = db.prepare(`
  INSERT INTO external_message_chunks (message_id, source, chunk_index, text, embedding)
  VALUES (@messageId, @source, @chunkIndex, @text, @embedding)
`);

export function insertExternalMessageChunk(chunk: Omit<ExternalMessageChunk, 'id'>): void {
  insertChunkStmt.run({
    messageId: chunk.messageId,
    source: chunk.source,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    embedding: JSON.stringify(chunk.embedding),
  });
}

/** Wipes a message's chunks before re-indexing — makes re-processing an edited (re-upserted) message idempotent, same idea as codeRepository.ts's deleteChunksForRepo. */
export function deleteChunksForMessage(messageId: string): void {
  db.prepare('DELETE FROM external_message_chunks WHERE message_id = ?').run(messageId);
}

export function getExternalMessageChunksBySource(source: ExternalMessageSource): ExternalMessageChunk[] {
  const rows = db.prepare('SELECT * FROM external_message_chunks WHERE source = ?').all(source) as any[];
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    source: r.source,
    chunkIndex: r.chunk_index,
    text: r.text,
    embedding: JSON.parse(r.embedding),
  }));
}

export interface ExternalMessageIndexSummary {
  source: ExternalMessageSource;
  messageCount: number;
  chunkCount: number;
  indexedAt: string | null;
}

/** For the status endpoint/UI — what's indexed per source and how current it is. */
export function getExternalMessageIndexSummary(): ExternalMessageIndexSummary[] {
  const rows = db
    .prepare(
      `SELECT c.source,
              COUNT(DISTINCT c.message_id) AS message_count,
              COUNT(*) AS chunk_count,
              MAX(c.indexed_at) AS indexed_at
       FROM external_message_chunks c
       GROUP BY c.source
       ORDER BY c.source ASC`
    )
    .all() as any[];
  return rows.map((r) => ({
    source: r.source,
    messageCount: r.message_count,
    chunkCount: r.chunk_count,
    indexedAt: r.indexed_at,
  }));
}

/** "Configured" for email/teams means "the external daily task has ever written a row of that source" — Speako has no credentials to check on its own side. */
export function hasAnyExternalMessages(source: ExternalMessageSource): boolean {
  const row = db.prepare('SELECT 1 FROM external_messages WHERE source = ? LIMIT 1').get(source);
  return !!row;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/storage/db';
import {
  getUnindexedMessages,
  markMessageIndexed,
  insertExternalMessageChunk,
  deleteChunksForMessage,
  getExternalMessageChunksBySource,
  getExternalMessageIndexSummary,
  hasAnyExternalMessages,
  upsertExternalMessage,
} from '../src/storage/externalMessageRepository';

// Mirrors how the external daily-indexing task writes raw rows (see docs/EXTERNAL_INGESTION_PROMPT.md) — Speako itself has no "insert external message" API by design.
function seedMessage(id: string, source: 'email' | 'teams', bodyText: string, indexed = false) {
  db.prepare(
    `INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text, indexed_at)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`
  ).run(id, source, 'Test', '[]', bodyText, indexed ? new Date().toISOString() : null);
}

test('hasAnyExternalMessages: false before any rows exist for a source', () => {
  assert.equal(hasAnyExternalMessages('teams'), false);
});

test('getUnindexedMessages: only returns rows with indexed_at IS NULL', () => {
  seedMessage('em-1', 'email', 'unindexed body');
  seedMessage('em-2', 'email', 'already indexed body', true);

  const unindexed = getUnindexedMessages().map((m) => m.id);
  assert.ok(unindexed.includes('em-1'));
  assert.ok(!unindexed.includes('em-2'));
});

test('hasAnyExternalMessages: true once a row of that source exists', () => {
  seedMessage('em-3', 'email', 'body');
  assert.equal(hasAnyExternalMessages('email'), true);
});

test('markMessageIndexed: removes the message from the unindexed set', () => {
  seedMessage('em-4', 'email', 'to be indexed');
  assert.ok(getUnindexedMessages().some((m) => m.id === 'em-4'));
  markMessageIndexed('em-4');
  assert.ok(!getUnindexedMessages().some((m) => m.id === 'em-4'));
});

test('insertExternalMessageChunk + getExternalMessageChunksBySource: round-trips and scopes by source', () => {
  seedMessage('em-5', 'teams', 'teams body');
  insertExternalMessageChunk({ messageId: 'em-5', source: 'teams', chunkIndex: 0, text: 'chunk one', embedding: [0.1, 0.2] });
  insertExternalMessageChunk({ messageId: 'em-5', source: 'teams', chunkIndex: 1, text: 'chunk two', embedding: [0.3, 0.4] });

  const teamsChunks = getExternalMessageChunksBySource('teams');
  assert.ok(teamsChunks.some((c) => c.text === 'chunk one'));
  assert.ok(teamsChunks.some((c) => c.text === 'chunk two'));
  assert.deepEqual(
    teamsChunks.find((c) => c.text === 'chunk one')!.embedding,
    [0.1, 0.2]
  );

  const emailChunks = getExternalMessageChunksBySource('email');
  assert.ok(!emailChunks.some((c) => c.messageId === 'em-5'));
});

test('deleteChunksForMessage: removes only that message\'s chunks', () => {
  seedMessage('em-6', 'email', 'body a');
  seedMessage('em-7', 'email', 'body b');
  insertExternalMessageChunk({ messageId: 'em-6', source: 'email', chunkIndex: 0, text: 'a-chunk', embedding: [1] });
  insertExternalMessageChunk({ messageId: 'em-7', source: 'email', chunkIndex: 0, text: 'b-chunk', embedding: [1] });

  deleteChunksForMessage('em-6');

  const remaining = getExternalMessageChunksBySource('email').map((c) => c.text);
  assert.ok(!remaining.includes('a-chunk'));
  assert.ok(remaining.includes('b-chunk'));
});

// Mirrors msGraphSync.ts's native ingestion path — see docs/EXTERNAL_INGESTION_PROMPT.md
// for the equivalent raw-SQL contract the external daily-agent path uses instead.
test('upsertExternalMessage: inserting a new id leaves it unindexed', () => {
  upsertExternalMessage({ id: 'graph-1', source: 'email', title: 'Hi', participants: ['a@x.com'], occurredAt: '2026-08-10T00:00:00Z', bodyText: 'body' });
  const unindexed = getUnindexedMessages().find((m) => m.id === 'graph-1');
  assert.ok(unindexed);
  assert.equal(unindexed!.title, 'Hi');
  assert.deepEqual(unindexed!.participants, ['a@x.com']);
});

test('upsertExternalMessage: re-upserting an already-indexed id resets indexed_at to NULL so it gets re-chunked', () => {
  upsertExternalMessage({ id: 'graph-2', source: 'teams', title: 'Old', participants: [], occurredAt: '2026-08-10T00:00:00Z', bodyText: 'old body' });
  markMessageIndexed('graph-2');
  assert.ok(!getUnindexedMessages().some((m) => m.id === 'graph-2'));

  upsertExternalMessage({ id: 'graph-2', source: 'teams', title: 'Edited', participants: [], occurredAt: '2026-08-10T01:00:00Z', bodyText: 'new body' });
  const reindexed = getUnindexedMessages().find((m) => m.id === 'graph-2');
  assert.ok(reindexed);
  assert.equal(reindexed!.title, 'Edited');
  assert.equal(reindexed!.bodyText, 'new body');
});

test('getExternalMessageIndexSummary: aggregates chunk/message counts per source', () => {
  // Compared as a delta rather than an exact count: earlier tests in this
  // file share the same in-memory DB and may have already added 'teams' rows.
  const before = getExternalMessageIndexSummary().find((s) => s.source === 'teams');
  const beforeMessages = before?.messageCount ?? 0;
  const beforeChunks = before?.chunkCount ?? 0;

  seedMessage('em-8', 'teams', 'body');
  insertExternalMessageChunk({ messageId: 'em-8', source: 'teams', chunkIndex: 0, text: 'x', embedding: [1] });
  insertExternalMessageChunk({ messageId: 'em-8', source: 'teams', chunkIndex: 1, text: 'y', embedding: [1] });

  const teamsSummary = getExternalMessageIndexSummary().find((s) => s.source === 'teams');
  assert.ok(teamsSummary);
  assert.equal(teamsSummary!.messageCount, beforeMessages + 1);
  assert.equal(teamsSummary!.chunkCount, beforeChunks + 2);
  assert.ok(teamsSummary!.indexedAt);
});

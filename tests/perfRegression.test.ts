import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/storage/db';
import { retrieve, indexSessionForRag } from '../src/rag/rag';
import { factCheckClaim } from '../src/factcheck/factcheck';
import { TranscriptSegment } from '../src/types';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import * as corpusRepositoryModule from '../src/storage/corpusRepository';
import * as bitbucketModule from '../src/integrations/bitbucketServer';
import * as jiraModule from '../src/integrations/jiraMcp';
import * as confluenceModule from '../src/integrations/confluenceMcp';
import * as webFactCheckModule from '../src/factcheck/webFactCheck';
import * as segmentRepositoryModule from '../src/storage/segmentRepository';
import { createSession } from '../src/storage/segmentRepository';

// These tests exist to give measured evidence (not just code review) that the
// optimization pass in this session actually reduced work rather than just
// moving it around. Each proves ONE specific mechanism by counting calls or
// using controlled artificial delays to prove a structural property (parallel
// vs sequential, cached vs re-queried, batched vs one-at-a-time) — not by
// asserting on wall-clock time against production code, which would be flaky.

test('db: idx_sessions_scheduled_start is used by getDueScheduledSessions\' query (SEARCH, not SCAN)', () => {
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id, name, language_codes FROM sessions
       WHERE scheduled_start_at IS NOT NULL AND scheduled_start_at <= ? AND ended_at IS NULL`
    )
    .all('2026-01-01T00:00:00.000Z') as { detail: string }[];
  const usesIndex = plan.some((row) => /USING INDEX idx_sessions_scheduled_start/i.test(row.detail));
  assert.ok(usesIndex, `expected the scheduled-start index to be used, got plan: ${JSON.stringify(plan)}`);
});

test('db: idx_sessions_type_meeting is used by a session_type+meeting_type filter (SEARCH, not SCAN)', () => {
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE session_type = ? AND meeting_type = ?`)
    .all('work', 'standup') as { detail: string }[];
  const usesIndex = plan.some((row) => /USING INDEX idx_sessions_type_meeting/i.test(row.detail));
  assert.ok(usesIndex, `expected the type+meeting_type index to be used, got plan: ${JSON.stringify(plan)}`);
});

test('rag: retrieve() reads the corpus from SQLite once and reuses the cache across repeated calls', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const embedSpy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { embedContent: async () => ({ embeddings: [{ values: [1, 0, 0] }] }) },
  }));
  const getAllChunksSpy = mock.method(corpusRepositoryModule, 'getAllChunks', () => []);
  try {
    // rag.ts's cache is module-level state that may already be warm from
    // another test in this same process — one call here guarantees it's
    // warm, then resetCalls() gives a clean baseline to assert against.
    await retrieve('warm the cache', 'session-a');
    getAllChunksSpy.mock.resetCalls();
    await retrieve('question one', 'session-a');
    await retrieve('question two', 'session-b');
    assert.equal(getAllChunksSpy.mock.callCount(), 0, 'expected the corpus cache to be reused, not re-queried, on subsequent retrieve() calls');
  } finally {
    embedSpy.mock.restore();
    getAllChunksSpy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test('factCheckClaim: the three internal source searches run concurrently, not sequentially', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const PER_CALL_DELAY_MS = 80;
  const spies = [
    mock.method(bitbucketModule, 'isBitbucketConfigured', () => true),
    mock.method(bitbucketModule, 'searchBitbucketServer', () => delay(PER_CALL_DELAY_MS, [])),
    mock.method(jiraModule, 'isJiraConfigured', () => true),
    mock.method(jiraModule, 'searchJira', () => delay(PER_CALL_DELAY_MS, [])),
    mock.method(confluenceModule, 'isConfluenceConfigured', () => true),
    mock.method(confluenceModule, 'searchConfluence', () => delay(PER_CALL_DELAY_MS, [])),
    mock.method(segmentRepositoryModule, 'getSession', () => ({ activeTools: null } as any)),
    // Isolate the concurrency proof from the (real, network-hitting) web
    // fallback path — that path only matters once the three internal
    // searches genuinely find nothing, which isn't what this test is about.
    mock.method(webFactCheckModule, 'isWebFactCheckConfigured', () => false),
  ];
  try {
    const start = Date.now();
    await factCheckClaim('the deploy went out on Friday', 'session-x');
    const elapsedMs = Date.now() - start;
    // Sequential would take ~3x PER_CALL_DELAY_MS; concurrent should be close to 1x.
    assert.ok(
      elapsedMs < PER_CALL_DELAY_MS * 2,
      `expected concurrent execution (~${PER_CALL_DELAY_MS}ms), took ${elapsedMs}ms — looks sequential (~${PER_CALL_DELAY_MS * 3}ms)`
    );
  } finally {
    spies.forEach((s) => s.mock.restore());
    updateSettings({ geminiApiKey: '' });
  }
});

test('indexSessionForRag: embeds with bounded concurrency instead of one segment at a time', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const PER_CALL_DELAY_MS = 30;
  const SEGMENT_COUNT = 16; // with concurrency 8, expect ~2 batches, not 16 sequential calls
  const embedSpy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { embedContent: async () => delay(PER_CALL_DELAY_MS, { embeddings: [{ values: [1, 0, 0] }] }) },
  }));
  createSession('session-embed-test', ['en-US'], 'Embed concurrency test', { sessionType: 'personal' });
  const segments: TranscriptSegment[] = Array.from({ length: SEGMENT_COUNT }, (_, i) => ({
    sessionId: 'session-embed-test',
    speaker: 'You',
    text: `segment number ${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    isFinal: true,
  }));

  try {
    const start = Date.now();
    await indexSessionForRag('session-embed-test', segments);
    const elapsedMs = Date.now() - start;
    // Fully sequential would take SEGMENT_COUNT * PER_CALL_DELAY_MS (~480ms).
    // Bounded concurrency (8) should take roughly 2 batches plus overhead.
    assert.ok(
      elapsedMs < SEGMENT_COUNT * PER_CALL_DELAY_MS * 0.6,
      `expected concurrent batching well under ${SEGMENT_COUNT * PER_CALL_DELAY_MS}ms (fully sequential), took ${elapsedMs}ms`
    );
  } finally {
    embedSpy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

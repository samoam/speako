import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  endSession,
  upsertInterimSegment,
  clearInterimSegment,
  clearInterimSegmentsForSession,
  closeOrphanedSessions,
  getSegmentsForSession,
  deleteSession,
} from '../src/storage/segmentRepository';
import { db } from '../src/storage/db';
import { TranscriptSegment } from '../src/types';

function interim(sessionId: string, speaker: string, text: string, startMs = 0): TranscriptSegment {
  return { sessionId, speaker, startMs, endMs: startMs + 1000, text, isFinal: false };
}

function countInterimRows(sessionId: string): number {
  return (db.prepare('SELECT COUNT(*) as c FROM interim_segments WHERE session_id = ?').get(sessionId) as { c: number }).c;
}

test('upsertInterimSegment: overwrites in place, one row per (session, speaker)', () => {
  createSession('interim-1', ['en-US'], 'Session', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-1', 'You', 'partial one'));
  upsertInterimSegment(interim('interim-1', 'You', 'partial one plus more'));
  upsertInterimSegment(interim('interim-1', 'Others', 'a different speaker'));

  assert.equal(countInterimRows('interim-1'), 2);
  const row = db.prepare('SELECT text FROM interim_segments WHERE session_id = ? AND speaker = ?').get('interim-1', 'You') as { text: string };
  assert.equal(row.text, 'partial one plus more');
});

test('clearInterimSegment: removes only the targeted speaker\'s row', () => {
  createSession('interim-2', ['en-US'], 'Session', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-2', 'You', 'x'));
  upsertInterimSegment(interim('interim-2', 'Others', 'y'));
  clearInterimSegment('interim-2', 'You');
  assert.equal(countInterimRows('interim-2'), 1);
});

test('clearInterimSegmentsForSession: removes every row for that session', () => {
  createSession('interim-3', ['en-US'], 'Session', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-3', 'You', 'x'));
  upsertInterimSegment(interim('interim-3', 'Others', 'y'));
  clearInterimSegmentsForSession('interim-3');
  assert.equal(countInterimRows('interim-3'), 0);
});

test('closeOrphanedSessions: recovers a leftover interim row as a real final segment for a session never cleanly stopped', () => {
  createSession('interim-orphan-1', ['en-US'], 'Crashed mid-sentence', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-orphan-1', 'You', 'we should ship the fix by'));
  // Deliberately not calling endSession() — this is exactly what a crash leaves behind.

  const { sessionsClosed, segmentsRecovered } = closeOrphanedSessions();
  assert.ok(sessionsClosed >= 1);
  assert.ok(segmentsRecovered >= 1);

  const segments = getSegmentsForSession('interim-orphan-1');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'we should ship the fix by');
  assert.equal(segments[0].isFinal, true);
  assert.equal(countInterimRows('interim-orphan-1'), 0);
});

test('closeOrphanedSessions: an empty/whitespace-only interim row is discarded, not recovered as a blank segment', () => {
  createSession('interim-orphan-2', ['en-US'], 'Crashed with nothing said', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-orphan-2', 'You', '   '));

  closeOrphanedSessions();

  assert.equal(getSegmentsForSession('interim-orphan-2').length, 0);
  assert.equal(countInterimRows('interim-orphan-2'), 0);
});

test('closeOrphanedSessions: a cleanly-ended session\'s interim rows are untouched (not orphaned)', () => {
  createSession('interim-clean', ['en-US'], 'Ended normally', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-clean', 'You', 'leftover, should not be touched'));
  endSession('interim-clean');

  closeOrphanedSessions();

  // Not an orphan (ended_at is set) — closeOrphanedSessions never looks at it.
  assert.equal(countInterimRows('interim-clean'), 1);
});

test('deleteSession: also removes interim_segments rows', () => {
  createSession('interim-delete', ['en-US'], 'Session', { sessionType: 'personal' });
  upsertInterimSegment(interim('interim-delete', 'You', 'x'));
  deleteSession('interim-delete');
  assert.equal(countInterimRows('interim-delete'), 0);
});

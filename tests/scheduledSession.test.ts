import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, setScheduledStartAt, getDueScheduledSessions, endSession, getSession, listSessions } from '../src/storage/segmentRepository';

test('createSession: scheduledStartAt round-trips and getDueScheduledSessions finds it once due', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  createSession('sched-1', ['en-US'], 'Scheduled session', { sessionType: 'work', scheduledStartAt: past });

  const due = getDueScheduledSessions(new Date().toISOString());
  assert.ok(due.some((d) => d.id === 'sched-1'));
  const match = due.find((d) => d.id === 'sched-1')!;
  assert.equal(match.name, 'Scheduled session');
  assert.deepEqual(match.languageCodes, ['en-US']);
});

test('getDueScheduledSessions: excludes sessions scheduled in the future', () => {
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  createSession('sched-2', ['en-US'], 'Future session', { sessionType: 'work', scheduledStartAt: future });

  const due = getDueScheduledSessions(new Date().toISOString());
  assert.ok(!due.some((d) => d.id === 'sched-2'));
});

test('getDueScheduledSessions: excludes sessions with no schedule at all', () => {
  createSession('sched-3', ['en-US'], 'Unscheduled session', { sessionType: 'work' });

  const due = getDueScheduledSessions(new Date().toISOString());
  assert.ok(!due.some((d) => d.id === 'sched-3'));
});

test('getDueScheduledSessions: excludes sessions that have already ended', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  createSession('sched-4', ['en-US'], 'Ended scheduled session', { sessionType: 'work', scheduledStartAt: past });
  endSession('sched-4');

  const due = getDueScheduledSessions(new Date().toISOString());
  assert.ok(!due.some((d) => d.id === 'sched-4'));
});

test('setScheduledStartAt: can set and cancel (null) a schedule after creation', () => {
  createSession('sched-5', ['en-US'], 'Set later', { sessionType: 'work' });
  const soon = new Date(Date.now() - 1000).toISOString();

  setScheduledStartAt('sched-5', soon);
  assert.ok(getDueScheduledSessions(new Date().toISOString()).some((d) => d.id === 'sched-5'));

  setScheduledStartAt('sched-5', null);
  assert.ok(!getDueScheduledSessions(new Date().toISOString()).some((d) => d.id === 'sched-5'));
});

test('getDueScheduledSessions: orders earliest-due first', () => {
  const earlier = new Date(Date.now() - 120_000).toISOString();
  const later = new Date(Date.now() - 60_000).toISOString();
  createSession('sched-later', ['en-US'], 'Later', { sessionType: 'work', scheduledStartAt: later });
  createSession('sched-earlier', ['en-US'], 'Earlier', { sessionType: 'work', scheduledStartAt: earlier });

  const due = getDueScheduledSessions(new Date().toISOString());
  const earlierIdx = due.findIndex((d) => d.id === 'sched-earlier');
  const laterIdx = due.findIndex((d) => d.id === 'sched-later');
  assert.ok(earlierIdx !== -1 && laterIdx !== -1);
  assert.ok(earlierIdx < laterIdx);
});

test('listSessions: surfaces scheduledStartAt for the sidebar, null when unset', () => {
  const iso = new Date(Date.now() - 1000).toISOString();
  createSession('sched-7', ['en-US'], 'Listed scheduled', { sessionType: 'work', scheduledStartAt: iso });
  createSession('sched-8', ['en-US'], 'Listed unscheduled', { sessionType: 'work' });

  const list = listSessions();
  assert.equal(list.find((s) => s.id === 'sched-7')!.scheduledStartAt, iso);
  assert.equal(list.find((s) => s.id === 'sched-8')!.scheduledStartAt, null);
});

test('getSession: does not surface scheduledStartAt (not part of that shape) but the session itself is queryable', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  createSession('sched-6', ['en-US'], 'Check getSession', { sessionType: 'work', scheduledStartAt: past });
  const s = getSession('sched-6');
  assert.ok(s);
  assert.equal(s!.id, 'sched-6');
});

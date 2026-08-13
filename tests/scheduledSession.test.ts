import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  setScheduledStartAt,
  setScheduledEndAt,
  getDueScheduledSessions,
  isScheduledEndDue,
  endSession,
  resumeSession,
  getSession,
  listSessions,
} from '../src/storage/segmentRepository';

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

test('createSession: calendarMeetingInfo round-trips through both getSession and listSessions', () => {
  const info = { location: 'Room 42', organizer: 'Jane Doe', attendees: ['Jane Doe', 'John Smith'], description: 'Quarterly planning' };
  createSession('sched-cmi-1', ['en-US'], 'Has calendar info', { sessionType: 'work', calendarEventId: 'evt-1', calendarMeetingInfo: info });

  const viaGetSession = getSession('sched-cmi-1');
  assert.deepEqual(viaGetSession!.calendarMeetingInfo, info);

  const viaListSessions = listSessions().find((s) => s.id === 'sched-cmi-1');
  assert.deepEqual(viaListSessions!.calendarMeetingInfo, info);
});

test('createSession: calendarMeetingInfo is null when omitted (a manually-created session with no calendar event)', () => {
  createSession('sched-cmi-2', ['en-US'], 'No calendar info', { sessionType: 'work' });
  assert.equal(getSession('sched-cmi-2')!.calendarMeetingInfo, null);
  assert.equal(listSessions().find((s) => s.id === 'sched-cmi-2')!.calendarMeetingInfo, null);
});

test('isScheduledEndDue: false with no scheduledEndAt at all', () => {
  createSession('sched-end-1', ['en-US'], 'No end scheduled', { sessionType: 'work' });
  assert.equal(isScheduledEndDue('sched-end-1', new Date().toISOString()), false);
});

test('isScheduledEndDue: false while the scheduled end time is still in the future', () => {
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  createSession('sched-end-2', ['en-US'], 'Ends later', { sessionType: 'work', scheduledEndAt: future });
  assert.equal(isScheduledEndDue('sched-end-2', new Date().toISOString()), false);
});

test('isScheduledEndDue: true once the scheduled end time has passed', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  createSession('sched-end-3', ['en-US'], 'Already ended', { sessionType: 'work', scheduledEndAt: past });
  assert.equal(isScheduledEndDue('sched-end-3', new Date().toISOString()), true);
});

test('resumeSession: clears endedAt so a stopped session can be recorded again', () => {
  createSession('sched-resume-1', ['en-US'], 'Cut short by mistake', { sessionType: 'work' });
  endSession('sched-resume-1');
  assert.ok(getSession('sched-resume-1')!.endedAt);

  resumeSession('sched-resume-1');
  assert.equal(getSession('sched-resume-1')!.endedAt, null);
});

test('setScheduledEndAt: can set and cancel (null) an end schedule after creation', () => {
  createSession('sched-end-4', ['en-US'], 'Set later', { sessionType: 'work' });
  const past = new Date(Date.now() - 1000).toISOString();

  setScheduledEndAt('sched-end-4', past);
  assert.equal(isScheduledEndDue('sched-end-4', new Date().toISOString()), true);

  setScheduledEndAt('sched-end-4', null);
  assert.equal(isScheduledEndDue('sched-end-4', new Date().toISOString()), false);
});

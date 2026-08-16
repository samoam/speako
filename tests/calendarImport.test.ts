import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as microsoft365Calendar from '../src/integrations/microsoft365Calendar';
import * as prepService from '../src/prep/PrepService';
import { createSession, getSessionIdByCalendarEventId } from '../src/storage/segmentRepository';
import { db } from '../src/storage/db';
import { getCurrentWeekRange, importUpcomingEventsThisWeek, toCalendarMeetingInfo } from '../src/calendar/calendarImport';

function isoAt(monday: Date, dayOffset: number, hour: number): string {
  const d = new Date(monday);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test('getCurrentWeekRange: a Wednesday resolves to that week\'s Monday 00:00 through the following Monday 00:00', () => {
  const wednesday = new Date('2026-08-12T15:30:00'); // a Wednesday
  const { startIso, endIso } = getCurrentWeekRange(wednesday);
  const start = new Date(startIso);
  const end = new Date(endIso);
  assert.equal(start.getDay(), 1); // Monday
  assert.equal(start.getHours(), 0);
  assert.equal(end.getTime() - start.getTime(), 7 * 24 * 60 * 60 * 1000);
});

test('getCurrentWeekRange: Sunday counts as the last day of its week, not the first of the next', () => {
  const sunday = new Date('2026-08-16T09:00:00'); // the Sunday ending the same week as the Wednesday above
  const { startIso } = getCurrentWeekRange(sunday);
  const wednesdayRange = getCurrentWeekRange(new Date('2026-08-12T15:30:00'));
  assert.equal(startIso, wednesdayRange.startIso);
});

test('importUpcomingEventsThisWeek: creates a session for a future event, skips a past one, a solo block, a canceled meeting, and one that already has a session', async () => {
  const monday = getCurrentWeekRangeMonday();
  const pastEvent = { id: 'evt-past', title: 'Already happened', description: '', startTime: isoAt(monday, 0, 0), attendeeCount: 2, isRecurring: false };
  const soloEvent = { id: `evt-solo-${Date.now()}`, title: 'Focus time', description: '', startTime: futureIso(), attendeeCount: 0, isRecurring: false };
  const canceledEvent = { id: `evt-canceled-${Date.now()}`, title: 'Canceled: Task Force', description: '', startTime: futureIso(), attendeeCount: 3, isRecurring: true, isCanceled: true };
  const futureEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const futureEvent = {
    id: `evt-future-${Date.now()}`,
    title: 'Sprint planning',
    description: 'Plan the next sprint',
    startTime: futureIso(),
    endTime: futureEnd,
    attendeeCount: 4,
    isRecurring: false,
    location: 'Room 7',
    organizer: 'Jane Doe',
    attendees: ['Jane Doe', 'John Smith'],
  };
  const alreadyImportedEvent = { id: 'evt-already-imported', title: 'Standup', description: '', startTime: futureIso(), attendeeCount: 3, isRecurring: true };

  const eventsSpy = mock.method(microsoft365Calendar, 'listMicrosoft365EventsInRange', async () => [pastEvent, soloEvent, canceledEvent, futureEvent, alreadyImportedEvent]);
  const prepSpy = mock.method(prepService, 'runPrep', async () => {});

  try {
    // Pre-seed a session for alreadyImportedEvent so dedup has something to find.
    createSession('calendar-import-existing-session', ['en-US'], 'Standup', { calendarEventId: 'evt-already-imported' });

    const result = await importUpcomingEventsThisWeek();

    assert.equal(result.createdSessionIds.length, 1);
    assert.equal(result.skipped, 1);
    assert.equal(prepSpy.mock.calls.length, 1);
    const prepCallArgs = prepSpy.mock.calls[0]!.arguments[0]!;
    assert.equal(prepCallArgs.calendarEventId, futureEvent.id);
    assert.equal(prepCallArgs.meetingType, 'sprint_planning');

    const createdSessionId = result.createdSessionIds[0];
    assert.equal(getSessionIdByCalendarEventId(futureEvent.id), createdSessionId);
    const row = db.prepare('SELECT scheduled_end_at, calendar_meeting_info FROM sessions WHERE id = ?').get(createdSessionId) as {
      scheduled_end_at: string;
      calendar_meeting_info: string;
    };
    assert.equal(row.scheduled_end_at, futureEnd);
    assert.deepEqual(JSON.parse(row.calendar_meeting_info), {
      location: 'Room 7',
      organizer: 'Jane Doe',
      attendees: ['Jane Doe', 'John Smith'],
      description: 'Plan the next sprint',
    });
    assert.equal(getSessionIdByCalendarEventId('evt-past'), undefined);
    assert.equal(getSessionIdByCalendarEventId(soloEvent.id), undefined);
    assert.equal(getSessionIdByCalendarEventId(canceledEvent.id), undefined);
  } finally {
    eventsSpy.mock.restore();
    prepSpy.mock.restore();
  }
});

test('toCalendarMeetingInfo: carries location/organizer/attendees/description through, empty description becomes undefined not empty string', () => {
  const withInfo = toCalendarMeetingInfo({
    id: 'e1', title: 'x', description: 'body text', startTime: futureIso(),
    attendeeCount: 2, isRecurring: false, location: 'Room 1', organizer: 'Jane', attendees: ['Jane', 'John'],
  } as any);
  assert.deepEqual(withInfo, { location: 'Room 1', organizer: 'Jane', attendees: ['Jane', 'John'], description: 'body text' });

  const noDescription = toCalendarMeetingInfo({
    id: 'e2', title: 'x', description: '', startTime: futureIso(), attendeeCount: 1, isRecurring: false,
  } as any);
  assert.equal(noDescription.description, undefined);
});

function getCurrentWeekRangeMonday(): Date {
  return new Date(getCurrentWeekRange().startIso);
}

function futureIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

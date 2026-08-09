import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, endSession, findLikelyPreviousSession, setPrepStatus, getSession } from '../src/storage/segmentRepository';
import { classifyMeetingType } from '../src/prep/meetingTypes';
import { CalendarEvent } from '../src/integrations/googleCalendar';

test('classifyMeetingType: defaults to generic with no calendar event', () => {
  assert.equal(classifyMeetingType(undefined), 'generic');
});

test('classifyMeetingType: matches standup only when recurring', () => {
  const nonRecurring: CalendarEvent = { id: '1', title: 'Standup', description: '', startTime: '', attendeeCount: 5, isRecurring: false };
  const recurring: CalendarEvent = { ...nonRecurring, isRecurring: true };
  assert.equal(classifyMeetingType(nonRecurring), 'generic');
  assert.equal(classifyMeetingType(recurring), 'standup');
});

test('classifyMeetingType: one-on-one requires <=2 attendees', () => {
  const small: CalendarEvent = { id: '1', title: '1:1 with Sam', description: '', startTime: '', attendeeCount: 2, isRecurring: false };
  const large: CalendarEvent = { ...small, attendeeCount: 8 };
  assert.equal(classifyMeetingType(small), 'one_on_one');
  assert.equal(classifyMeetingType(large), 'generic');
});

test('classifyMeetingType: matches sprint review and sprint planning by title keyword', () => {
  const review: CalendarEvent = { id: '1', title: 'Sprint Review', description: '', startTime: '', attendeeCount: 6, isRecurring: false };
  const planning: CalendarEvent = { id: '2', title: 'Sprint Planning', description: '', startTime: '', attendeeCount: 6, isRecurring: false };
  assert.equal(classifyMeetingType(review), 'sprint_review');
  assert.equal(classifyMeetingType(planning), 'sprint_planning');
});

test('classifyMeetingType: matches retro by title keyword, does not require recurrence', () => {
  const retro: CalendarEvent = { id: '1', title: 'Team Retrospective', description: '', startTime: '', attendeeCount: 6, isRecurring: false };
  assert.equal(classifyMeetingType(retro), 'retro');
});

test('classifyMeetingType: matches design_dev from description, not just title', () => {
  const event: CalendarEvent = {
    id: '1',
    title: 'Weekly Sync',
    description: 'Architecture review and design discussion for the new pipeline.',
    startTime: '',
    attendeeCount: 4,
    isRecurring: false,
  };
  assert.equal(classifyMeetingType(event), 'design_dev');
});

test('classifyMeetingType: standup keyword alone is not enough without recurrence', () => {
  const oneOff: CalendarEvent = { id: '1', title: 'Standup', description: '', startTime: '', attendeeCount: 5, isRecurring: false };
  assert.equal(classifyMeetingType(oneOff), 'generic');
});

test('findLikelyPreviousSession: prefers exact name match over most-recent-of-type', () => {
  createSession('s1', ['en-US'], 'Team Standup', { sessionType: 'work', meetingType: 'standup' });
  endSession('s1');
  createSession('s2', ['en-US'], 'Some Other Standup', { sessionType: 'work', meetingType: 'standup' });
  endSession('s2');
  createSession('s3', ['en-US'], 'Team Standup', { sessionType: 'work', meetingType: 'standup' });
  endSession('s3');

  const match = findLikelyPreviousSession('standup', 'Team Standup', 's4');
  assert.equal(match?.id, 's3'); // exact name match, most recent of the two exact matches
});

test('findLikelyPreviousSession: falls back to most-recent-of-type when no name match', () => {
  createSession('s5', ['en-US'], 'Retro A', { sessionType: 'work', meetingType: 'retro' });
  endSession('s5');
  createSession('s6', ['en-US'], 'Retro B', { sessionType: 'work', meetingType: 'retro' });
  endSession('s6');

  const match = findLikelyPreviousSession('retro', 'Totally Different Name', 's7');
  assert.equal(match?.id, 's6'); // most recently ended, no exact name match exists
});

test('findLikelyPreviousSession: returns undefined when nothing matches', () => {
  const match = findLikelyPreviousSession('design_dev', 'Anything', 's8');
  assert.equal(match, undefined);
});

test('setPrepStatus updates the session row', () => {
  createSession('s9', ['en-US'], 'Prep Test', { sessionType: 'work', meetingType: 'generic' });
  setPrepStatus('s9', 'ready');
  assert.equal(getSession('s9')?.prepStatus, 'ready');
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeConnectorCliModule from '../src/integrations/claudeConnectorCli';
import { listUpcomingMicrosoft365Events, listMicrosoft365EventsInRange } from '../src/integrations/microsoft365Calendar';

function connectorEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    subject: 'Sprint planning',
    organizer: 'jane@acceo.com',
    attendees: ['jane@acceo.com', 'john@acceo.com'],
    start: { dateTime: '2026-08-17T09:00:00.0000000' },
    end: { dateTime: '2026-08-17T09:30:00.0000000' },
    location: 'Room 7',
    summary: 'Plan the sprint',
    isCancelled: false,
    recurrence: null,
    ...overrides,
  };
}

test('listMicrosoft365EventsInRange: maps connector fields into the shared CalendarEvent shape', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async () => [connectorEvent()]);
  try {
    const events = await listMicrosoft365EventsInRange('2026-08-17T00:00:00Z', '2026-08-18T00:00:00Z');
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.id, 'evt-1');
    assert.equal(event.title, 'Sprint planning');
    assert.equal(event.description, 'Plan the sprint');
    assert.equal(event.startTime, '2026-08-17T09:00:00.000');
    assert.equal(event.endTime, '2026-08-17T09:30:00.000');
    assert.equal(event.attendeeCount, 1); // 2 attendees minus the signed-in user
    assert.equal(event.isRecurring, false);
    assert.equal(event.isCanceled, false);
    assert.equal(event.location, 'Room 7');
    assert.equal(event.organizer, 'jane@acceo.com');
    assert.equal(spy.mock.calls[0]!.arguments[0]!.tool, 'outlook_calendar_search');
  } finally {
    spy.mock.restore();
  }
});

test('listMicrosoft365EventsInRange: a solo block (only the signed-in user as attendee) resolves to attendeeCount 0', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async () => [connectorEvent({ id: 'evt-solo', attendees: ['me@acceo.com'] })]);
  try {
    const [event] = await listMicrosoft365EventsInRange('2026-08-17T00:00:00Z', '2026-08-18T00:00:00Z');
    assert.equal(event.attendeeCount, 0);
  } finally {
    spy.mock.restore();
  }
});

test('listUpcomingMicrosoft365Events: dispatches a search bounded by now + windowMinutes', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async () => []);
  try {
    await listUpcomingMicrosoft365Events(30);
    assert.equal(spy.mock.callCount(), 1);
    const args = spy.mock.calls[0]!.arguments[0]!.args;
    assert.equal(args.afterDateTime, 'now');
    assert.equal(typeof args.beforeDateTime, 'string');
  } finally {
    spy.mock.restore();
  }
});

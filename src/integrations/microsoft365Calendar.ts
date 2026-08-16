import { paginateConnectorTool } from './claudeConnectorCli';
import { CalendarEvent } from './googleCalendar';

const PAGE_LIMIT = 25;

interface ConnectorCalendarEvent {
  id: string;
  subject?: string;
  organizer?: string;
  attendees?: string[];
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: string;
  summary?: string;
  isCancelled?: boolean;
  recurrence?: unknown;
}

/**
 * The connector returns a wall-clock string in the mailbox's own time zone
 * (confirmed live: "2026-08-17T09:00:00.0000000", "Eastern Standard Time")
 * with a 7-digit fractional-seconds component `Date()` doesn't reliably
 * parse — truncated to milliseconds here. No offset/Z suffix is present, so
 * `new Date(...)` parses it as local time per the ES spec's date-time (not
 * date-only) parsing rule — correct as long as this process runs in the
 * same time zone as the mailbox, true for a single-user desktop app.
 */
function toDateString(dateTime: string | undefined): string | undefined {
  if (!dateTime) return undefined;
  return dateTime.replace(/(\.\d{3})\d*$/, '$1');
}

function mapEventToCalendarEvent(event: ConnectorCalendarEvent): CalendarEvent {
  const attendees = event.attendees?.length ? event.attendees : undefined;
  return {
    id: event.id,
    title: event.subject || '(untitled event)',
    description: event.summary || '',
    startTime: toDateString(event.start?.dateTime) || '',
    endTime: toDateString(event.end?.dateTime),
    // Approximates "other attendees besides me" by excluding one slot for
    // the signed-in user, who's always included in `attendees` for events
    // on their own calendar — a solo block (attendees: [me]) resolves to 0.
    attendeeCount: Math.max(0, (event.attendees?.length ?? 0) - 1),
    isRecurring: !!event.recurrence,
    isCanceled: !!event.isCancelled,
    attendees,
    location: event.location || undefined,
    organizer: event.organizer || undefined,
  };
}

async function searchAllEvents(args: Record<string, unknown>): Promise<CalendarEvent[]> {
  const events = await paginateConnectorTool<ConnectorCalendarEvent>({ tool: 'outlook_calendar_search', args: { ...args, limit: PAGE_LIMIT } });
  return events.map(mapEventToCalendarEvent);
}

/**
 * Calendar reads via the Microsoft 365 Claude connector — replaces the old
 * Outlook-desktop COM automation (outlookDesktop.ts), which existed only to
 * route around a Graph/B2B-guest identity wall the connector doesn't have.
 * Returns the same CalendarEvent shape googleCalendar.ts's
 * listUpcomingEvents does, so classifyMeetingType() and every other
 * "upcoming events" consumer works unchanged regardless of source.
 */
export async function listUpcomingMicrosoft365Events(windowMinutes: number): Promise<CalendarEvent[]> {
  const beforeDateTime = new Date(Date.now() + windowMinutes * 60_000).toISOString();
  return searchAllEvents({ query: '*', afterDateTime: 'now', beforeDateTime, order: 'oldest' });
}

/** Same connector read, but for an explicit [startIso, endIso) range — what the week-grid calendar view needs. */
export async function listMicrosoft365EventsInRange(startIso: string, endIso: string): Promise<CalendarEvent[]> {
  return searchAllEvents({ query: '*', afterDateTime: startIso, beforeDateTime: endIso, order: 'oldest' });
}

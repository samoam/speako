import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { CalendarEvent } from '../integrations/googleCalendar';
import { listMicrosoft365EventsInRange } from '../integrations/microsoft365Calendar';
import { classifyMeetingType } from '../prep/meetingTypes';
import { createSession, getSessionIdByCalendarEventId, CalendarMeetingInfo } from '../storage/segmentRepository';
import { runPrep } from '../prep/PrepService';

/** Carries a calendar event's raw Outlook/Google metadata onto the session it creates — see CalendarMeetingInfo. */
export function toCalendarMeetingInfo(event: CalendarEvent): CalendarMeetingInfo {
  return {
    location: event.location,
    organizer: event.organizer,
    attendees: event.attendees,
    description: event.description || undefined,
  };
}

/**
 * Monday 00:00 through the following Monday 00:00, in local time — matches
 * how the week-grid calendar view lays days out. Sunday counts as the last
 * day of the week (ISO-style), not the first.
 */
export function getCurrentWeekRange(now: Date = new Date()): { startIso: string; endIso: string } {
  const day = now.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + diffToMonday);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { startIso: monday.toISOString(), endIso: nextMonday.toISOString() };
}

/** Every meeting in the current week, for the grid view — past and future alike, so already-elapsed days aren't just blank. */
export async function getCurrentWeekEvents(): Promise<CalendarEvent[]> {
  const { startIso, endIso } = getCurrentWeekRange();
  return listMicrosoft365EventsInRange(startIso, endIso);
}

export interface CalendarImportResult {
  createdSessionIds: string[];
  skipped: number;
}

/**
 * Auto-creates a session for every not-yet-started meeting in the current
 * week that doesn't already have one — deliberately excludes events whose
 * start time has already passed. Importing a past event would set
 * `scheduledStartAt` in the past, which `checkScheduledSessions()` in
 * server.ts would then treat as "due" and auto-start a recording for a
 * meeting that already happened. Also excludes solo events (no other
 * attendees) — personal blocks, focus time, reminders — since there's no
 * one else to have a "meeting" with; only `attendeeCount > 0` counts. And
 * excludes canceled meetings (`isCanceled`, confirmed against real Outlook
 * data as `MeetingStatus` 5/olMeetingCanceled or 7/olMeetingReceivedAndCanceled)
 * — Outlook keeps a canceled appointment visible on the calendar rather than
 * removing it, so without this filter every cancellation would still spawn
 * a session for a meeting that's never actually happening.
 * Dedup is by `calendar_event_id` (getSessionIdByCalendarEventId), so
 * reruns of this poll never double-import the same event — including one a
 * user already created manually via the New Session modal's calendar
 * picker. Also sets `scheduledEndAt` from the event's `endTime` (when
 * present), so `checkScheduledEndSessions()` in server.ts can auto-stop the
 * recording once the meeting's real end time arrives — not just auto-start
 * it. Events with no `endTime` just never auto-stop, same fallback as the
 * grid's default 30-minute block width.
 */
export async function importUpcomingEventsThisWeek(
  onSessionCreated?: (sessionId: string, event: CalendarEvent) => void
): Promise<CalendarImportResult> {
  const events = await getCurrentWeekEvents();
  const now = Date.now();
  const createdSessionIds: string[] = [];
  let skipped = 0;

  for (const event of events) {
    if (new Date(event.startTime).getTime() <= now) continue; // already happened — see rationale above
    if (event.attendeeCount <= 0) continue; // solo block — no one else attending
    if (event.isCanceled) continue; // canceled meetings stay on the calendar but aren't actually happening

    if (getSessionIdByCalendarEventId(event.id)) {
      skipped++;
      continue;
    }

    const meetingType = classifyMeetingType(event);
    const sessionId = uuid();
    createSession(sessionId, config.languageCodes, event.title, {
      prepStatus: 'pending',
      meetingType,
      calendarEventId: event.id,
      scheduledStartAt: event.startTime,
      scheduledEndAt: event.endTime,
      calendarMeetingInfo: toCalendarMeetingInfo(event),
    });

    runPrep({
      sessionId,
      sessionName: event.title,
      meetingType,
      calendarEventId: event.id,
      activeTools: null,
    }).catch((err: any) => console.error(`[calendar-import] prep failed for session ${sessionId}:`, err.message));

    createdSessionIds.push(sessionId);
    onSessionCreated?.(sessionId, event);
  }

  return { createdSessionIds, skipped };
}

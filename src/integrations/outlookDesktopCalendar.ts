import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { CalendarEvent } from './googleCalendar';
import { isOutlookDesktopConfigured } from './outlookDesktop';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'outlookCalendarExport.ps1');
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

interface OutlookAppointment {
  id: string;
  subject?: string | null;
  description?: string | null;
  startTime: string;
  attendeeCount?: number;
  isRecurring?: boolean;
}

function mapAppointmentToCalendarEvent(item: OutlookAppointment): CalendarEvent {
  return {
    id: item.id,
    title: item.subject || '(untitled event)',
    description: item.description || '',
    startTime: item.startTime,
    attendeeCount: item.attendeeCount || 0,
    isRecurring: !!item.isRecurring,
  };
}

/**
 * Outlook desktop's Calendar-folder equivalent of outlookDesktop.ts's mail
 * export — same COM automation rationale (works regardless of Exchange
 * Online/hybrid/on-prem, rides the local Outlook profile's existing
 * connection). Returns the same CalendarEvent shape googleCalendar.ts's
 * listUpcomingEvents does, so classifyMeetingType() and any other consumer
 * of "upcoming events" work unchanged regardless of which source produced
 * them — server.ts's /api/calendar/upcoming picks this as a fallback when
 * Google Calendar isn't configured (see NOTES.md).
 */
export async function listUpcomingOutlookEvents(windowMinutes: number): Promise<CalendarEvent[]> {
  if (!isOutlookDesktopConfigured()) return [];

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-WindowMinutes', String(windowMinutes)],
    { maxBuffer: MAX_BUFFER_BYTES, timeout: TIMEOUT_MS }
  );
  const items: OutlookAppointment[] = JSON.parse(stdout);
  return items.map(mapAppointmentToCalendarEvent);
}

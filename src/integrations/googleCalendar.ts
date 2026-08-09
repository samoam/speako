import * as fs from 'fs';
import { google } from 'googleapis';
import { config } from '../config';

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  startTime: string;
  attendeeCount: number;
  isRecurring: boolean;
}

/** Fully configured means both the OAuth client secret AND a saved token exist — the one-time `npm run gcal-auth` setup has been completed. */
export function isCalendarConfigured(): boolean {
  return !!(
    config.googleCalendarCredentialsPath &&
    fs.existsSync(config.googleCalendarCredentialsPath) &&
    fs.existsSync(config.googleCalendarTokenPath)
  );
}

export function getOAuth2Client() {
  const raw = JSON.parse(fs.readFileSync(config.googleCalendarCredentialsPath, 'utf-8'));
  const creds = raw.installed || raw.web;
  const client = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris[0]);
  if (fs.existsSync(config.googleCalendarTokenPath)) {
    client.setCredentials(JSON.parse(fs.readFileSync(config.googleCalendarTokenPath, 'utf-8')));
  }
  return client;
}

/**
 * Events starting within the next `windowMinutes` — used both by the
 * calendar-aware "prep this meeting" shortcuts and by the background poller.
 * Returns an empty list rather than throwing if calendar isn't configured,
 * matching every other optional-integration's "skip, don't error" pattern.
 */
export async function listUpcomingEvents(windowMinutes: number): Promise<CalendarEvent[]> {
  if (!isCalendarConfigured()) return [];

  const calendar = google.calendar({ version: 'v3', auth: getOAuth2Client() });
  const now = new Date();
  const until = new Date(now.getTime() + windowMinutes * 60_000);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 10,
  });

  return (res.data.items || []).map((event) => ({
    id: event.id || '',
    title: event.summary || '(untitled event)',
    description: event.description || '',
    startTime: event.start?.dateTime || event.start?.date || '',
    attendeeCount: event.attendees?.length || 0,
    isRecurring: !!event.recurringEventId,
  }));
}

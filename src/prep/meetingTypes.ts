import { CalendarEvent } from '../integrations/googleCalendar';

export type MeetingType =
  | 'standup'
  | 'sprint_planning'
  | 'sprint_review'
  | 'retro'
  | 'one_on_one'
  | 'design_dev'
  | 'generic';

export const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  standup: 'Standup',
  sprint_planning: 'Sprint Planning',
  sprint_review: 'Sprint Review',
  retro: 'Retro',
  one_on_one: 'One-on-One',
  design_dev: 'Design / Dev Discussion',
  generic: 'Other',
};

interface TypeSignals {
  titleKeywords: string[];
  maxAttendeesForMatch?: number;
  recurringOnly?: boolean;
}

/**
 * Extensible by design — add a new type here rather than hardcoding
 * conditionals elsewhere, per the meeting-type taxonomy being "a starting v1
 * set" that varies by team naming conventions.
 */
const SIGNALS: Record<Exclude<MeetingType, 'generic'>, TypeSignals> = {
  standup: { titleKeywords: ['standup', 'stand-up', 'daily'], recurringOnly: true },
  sprint_review: { titleKeywords: ['sprint review', 'demo'] },
  sprint_planning: { titleKeywords: ['sprint planning', 'planning'] },
  retro: { titleKeywords: ['retro', 'retrospective'] },
  one_on_one: { titleKeywords: ['1:1', '1-on-1', 'one-on-one', 'one on one'], maxAttendeesForMatch: 2 },
  design_dev: { titleKeywords: ['design', 'design review', 'tech discussion', 'architecture'] },
};

/**
 * Best-effort classification from calendar metadata — always overridable in
 * the UI (manual override is essential, not optional; misclassification
 * should fail toward 'generic' rather than a confidently wrong specific
 * type). Returns 'generic' when there's no calendar event at all (ad hoc/
 * manually created work sessions).
 */
export function classifyMeetingType(event?: CalendarEvent): MeetingType {
  if (!event) return 'generic';

  const titleLower = (event.title + ' ' + event.description).toLowerCase();

  for (const [type, signals] of Object.entries(SIGNALS) as [Exclude<MeetingType, 'generic'>, TypeSignals][]) {
    if (signals.recurringOnly && !event.isRecurring) continue;
    if (signals.maxAttendeesForMatch && event.attendeeCount > signals.maxAttendeesForMatch) continue;
    if (signals.titleKeywords.some((kw) => titleLower.includes(kw))) return type;
  }

  return 'generic';
}

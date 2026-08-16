import { config } from '../config';

/** Pure comparison, split out from isWithinBusinessHours() for testability (avoids mocking the system clock). */
export function isHourWithinRange(hour: number, startHour: number, endHour: number): boolean {
  return hour >= startHour && hour < endHour;
}

/** Gates the automatic sync timers (Jira/Bitbucket/Teams/Email) to a configured local-time window — deliberately does NOT gate the manual "Sync now" routes, which call the same run*Sync() methods directly rather than through a timer. */
export function isWithinBusinessHours(): boolean {
  return isHourWithinRange(new Date().getHours(), config.businessHoursStartHour, config.businessHoursEndHour);
}

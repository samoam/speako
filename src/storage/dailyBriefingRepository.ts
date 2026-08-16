import { db } from './db';

export interface DailyBriefing {
  date: string;
  content: string;
  createdAt: string;
}

/** Server's local calendar date (YYYY-MM-DD) — the key a briefing is generated at most once per. */
export function todayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getTodaysBriefing(): DailyBriefing | undefined {
  const row = db.prepare('SELECT * FROM daily_briefings WHERE date = ?').get(todayDateString()) as any;
  return row ? { date: row.date, content: row.content, createdAt: row.created_at } : undefined;
}

export function saveTodaysBriefing(content: string): void {
  db.prepare('INSERT OR REPLACE INTO daily_briefings (date, content) VALUES (?, ?)').run(todayDateString(), content);
}

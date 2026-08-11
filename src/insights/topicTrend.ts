import { getSessionsWithTopics } from '../storage/summaryRepository';

export interface TopicMention {
  sessionId: string;
  name: string | null;
  startedAt: string;
}

export interface TopicFrequency {
  topic: string;
  count: number;
  sessions: TopicMention[];
}

/**
 * Aggregates the topic tags Gemini already produces during on-demand
 * summarization (SUMMARY_SCHEMA's `topics` field, summarize.ts) across every
 * session that's been summarized — no separate extraction call. Topics are
 * only as complete as which sessions have been summarized; sessions without
 * a summary yet simply don't contribute until one is generated.
 *
 * Case-insensitive dedup (Gemini's own casing for the same topic can drift
 * call to call, e.g. "SoX audio driver" vs "sox audio driver") — the first
 * casing seen for a topic is kept as its display label.
 */
export function getTopicFrequencies(): TopicFrequency[] {
  const sessions = getSessionsWithTopics();
  const byKey = new Map<string, TopicFrequency>();

  for (const session of sessions) {
    for (const topic of session.topics) {
      const key = topic.trim().toLowerCase();
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { topic: topic.trim(), count: 0, sessions: [] };
        byKey.set(key, entry);
      }
      entry.count++;
      entry.sessions.push({ sessionId: session.sessionId, name: session.name, startedAt: session.startedAt });
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
}

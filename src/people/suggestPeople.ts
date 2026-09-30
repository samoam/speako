import { db } from '../storage/db';
import { personExists } from '../storage/peopleRepository';
import { detectMyTeamsDisplayName } from '../communications/teamsMessageTriage';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { getPullRequestActivity } from '../integrations/bitbucketReviews';
import { config } from '../config';
import { getJiraCommentMentions } from '../integrations/jiraMcp';

/** Every name (raw, not yet filtered against the directory) already sitting in synced Teams/email data — participants[0] is the sender, same convention externalMessageRepository.ts's callers already rely on. */
function namesFromExternalMessages(): string[] {
  const rows = db.prepare(`SELECT DISTINCT participants, source FROM external_messages WHERE participants IS NOT NULL`).all() as { participants: string; source: string }[];
  const myTeamsName = detectMyTeamsDisplayName();
  const names: string[] = [];
  for (const row of rows) {
    let participants: string[];
    try {
      participants = JSON.parse(row.participants);
    } catch {
      continue;
    }
    const sender = participants[0];
    if (!sender) continue;
    // Email rows are inbox-only (never the user's own Sent Items, see
    // emailTriage.ts's header comment), so every sender there is already
    // someone else — only Teams rows need the "is this actually me"
    // exclusion, the same one getUntriagedTeamsMessages() already applies.
    if (row.source === 'teams' && myTeamsName && sender === myTeamsName) continue;
    names.push(sender);
  }
  return names;
}

async function namesFromBitbucket(): Promise<string[]> {
  if (!isBitbucketConfigured()) return [];
  const activity = await getPullRequestActivity();
  return [
    ...activity.reviewRequests.map((pr) => pr.authorName),
    ...activity.mentionsOfMe.map((c) => c.authorName),
    ...activity.commentsOnMyPRs.map((c) => c.authorName),
  ];
}

async function namesFromJira(): Promise<string[]> {
  if (!config.jiraUserIdentifier) return [];
  const mentions = await getJiraCommentMentions();
  return mentions.map((m) => m.authorName);
}

/**
 * Candidate names for the People directory (src/storage/peopleRepository.ts)
 * — "who have you heard from that isn't in your directory yet" — gathered
 * from data Speako already has (synced Teams/email messages) or can fetch
 * live from already-configured integrations (Bitbucket, Jira), never a new
 * network call of its own. Each source is best-effort/independent so one
 * failing integration doesn't blank the whole list, same tolerance
 * src/orchestrator/taskSync.ts's syncTasks() already applies to its own
 * per-source fan-out.
 */
export async function getPeopleSuggestions(): Promise<string[]> {
  const [bitbucketNames, jiraNames] = await Promise.all([
    namesFromBitbucket().catch((err: any) => {
      console.error('[suggestPeople] Bitbucket lookup failed:', err.message);
      return [] as string[];
    }),
    namesFromJira().catch((err: any) => {
      console.error('[suggestPeople] Jira lookup failed:', err.message);
      return [] as string[];
    }),
  ]);
  const allNames = [...namesFromExternalMessages(), ...bitbucketNames, ...jiraNames];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const name of allNames) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (personExists(name)) continue;
    candidates.push(name);
  }
  return candidates.sort((a, b) => a.localeCompare(b));
}

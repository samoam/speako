import { isJiraConfigured, getMyOpenJiraIssues, JiraTaskMatch } from '../integrations/jiraMcp';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { getPullRequestActivity } from '../integrations/bitbucketReviews';
import { getAllOpenActionItems, ActionItemWithSession } from '../storage/summaryRepository';
import { upsertTask, pruneTasksForSource, UpsertTaskInput } from '../storage/taskRepository';

/** 1 (lowest) - 5 (highest) — days-until-due buckets shared by every source that has a real due date. */
function urgencyFromDueDate(dueDate: string | null | undefined): number {
  if (!dueDate) return 2;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 2;
  const daysUntil = (due - Date.now()) / (24 * 60 * 60 * 1000);
  if (daysUntil <= 0) return 5; // overdue or due today
  if (daysUntil <= 7) return 4; // this week
  if (daysUntil <= 30) return 3; // this month
  return 2;
}

const JIRA_PRIORITY_SCORE: Record<string, number> = {
  blocker: 5,
  highest: 5,
  critical: 4,
  high: 4,
  major: 3,
  medium: 3,
  minor: 2,
  low: 2,
  trivial: 1,
  lowest: 1,
};

function jiraImportance(priorityName: string | null): number {
  if (!priorityName) return 3;
  return JIRA_PRIORITY_SCORE[priorityName.toLowerCase()] ?? 3;
}

function jiraIssueToTask(issue: JiraTaskMatch): UpsertTaskInput {
  return {
    source: 'jira',
    externalRef: issue.key,
    title: issue.key ? `${issue.key}: ${issue.summary}` : issue.summary,
    description: issue.statusName ? `Status: ${issue.statusName}` : null,
    url: issue.url,
    dueDate: issue.dueDate,
    importanceScore: jiraImportance(issue.priorityName),
    urgencyScore: urgencyFromDueDate(issue.dueDate),
  };
}

/** 1 (fresh) - 5 (stale) — a review request sitting unreviewed longer is more urgent, not less. */
function reviewRequestUrgency(createdDate: string | null): number {
  if (!createdDate) return 3;
  const ageMs = Date.now() - new Date(createdDate).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays >= 7) return 5;
  if (ageDays >= 2) return 4;
  return 3;
}

function actionItemImportance(confidence: ActionItemWithSession['confidence']): number {
  return confidence === 'inferred' ? 3 : 4; // explicit/manual were both deliberate; inferred is a guess
}

async function syncJira(): Promise<void> {
  if (!isJiraConfigured()) return;
  const issues = await getMyOpenJiraIssues();
  for (const issue of issues) upsertTask(jiraIssueToTask(issue));
  pruneTasksForSource('jira', issues.map((i) => i.key));
}

async function syncBitbucket(): Promise<void> {
  if (!isBitbucketConfigured()) return;
  const activity = await getPullRequestActivity();
  const refs: string[] = [];

  for (const pr of activity.reviewRequests) {
    const ref = `${pr.projectKey}/${pr.repoSlug}#${pr.id}`;
    refs.push(ref);
    upsertTask({
      source: 'bitbucket_pr',
      externalRef: ref,
      title: `Review: ${pr.title}`,
      description: `${pr.projectKey}/${pr.repoSlug}#${pr.id} by ${pr.authorName} — your status: ${pr.myApprovalStatus ?? 'unknown'}`,
      url: pr.link,
      dueDate: null,
      importanceScore: 4,
      urgencyScore: reviewRequestUrgency(pr.createdDate),
    });
  }

  for (const comment of activity.mentionsOfMe) {
    const ref = `${comment.projectKey}/${comment.repoSlug}#${comment.prId}:${comment.createdDate}:${comment.authorName}`;
    refs.push(ref);
    upsertTask({
      source: 'bitbucket_pr',
      externalRef: ref,
      title: `Mentioned in: ${comment.prTitle}`,
      description: `${comment.authorName}: ${comment.text.slice(0, 300)}`,
      url: null,
      dueDate: null,
      importanceScore: 3,
      urgencyScore: 3,
    });
  }

  pruneTasksForSource('bitbucket_pr', refs);
}

async function syncActionItems(): Promise<void> {
  const items = getAllOpenActionItems();
  const refs: string[] = [];
  for (const item of items) {
    const ref = String(item.id);
    refs.push(ref);
    upsertTask({
      source: 'action_item',
      externalRef: ref,
      title: item.description,
      description: item.sessionName ? `From: ${item.sessionName}` : null,
      // Not a real URL — a client-recognized pseudo-scheme the frontend's
      // Plate row click handler special-cases (openSession + switchTab)
      // instead of window.open()'ing it, since this points at a session
      // inside the same single-page app, not an external resource.
      url: `session://${item.sessionId}`,
      dueDate: item.dueDate,
      importanceScore: actionItemImportance(item.confidence),
      urgencyScore: urgencyFromDueDate(item.dueDate),
    });
  }
  pruneTasksForSource('action_item', refs);
}

/**
 * Fans out to every "what's on my plate" source and upserts them into the
 * unified tasks table — src/interface/server.ts's orchestrator poller (and
 * its manual "Sync now" route) call this. Promise.allSettled, not
 * Promise.all/for-of, so one source's total failure (e.g. Jira down) never
 * blocks the others from still syncing — mirrors msGraphSync.ts's per-source
 * try/catch isolation. Each connector already tolerates its own partial
 * failures internally (getPullRequestActivity's per-PR comment fetch,
 * getMyOpenJiraIssues' fail-to-empty-array on a bad response).
 */
export async function syncTasks(): Promise<{ synced: string[]; failed: string[] }> {
  const sources: { name: string; run: () => Promise<void> }[] = [
    { name: 'jira', run: syncJira },
    { name: 'bitbucket', run: syncBitbucket },
    { name: 'action_items', run: syncActionItems },
  ];

  const results = await Promise.allSettled(sources.map((s) => s.run()));
  const synced: string[] = [];
  const failed: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      synced.push(sources[i].name);
    } else {
      failed.push(sources[i].name);
      console.error(`[orchestrator] task sync failed for source "${sources[i].name}":`, (result.reason as any)?.message ?? result.reason);
    }
  });
  return { synced, failed };
}

import { isJiraConfigured, getMyOpenJiraIssues, JiraTaskMatch } from '../integrations/jiraMcp';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { getPullRequestActivity } from '../integrations/bitbucketReviews';
import { getAllOpenActionItems, ActionItemWithSession } from '../storage/summaryRepository';
import { upsertTask, pruneTasksForSource, UpsertTaskInput } from '../storage/taskRepository';
import { getCurrentFailingBuilds } from '../storage/jenkinsBuildRepository';
import { isJenkinsConfigured } from '../integrations/jenkinsClient';
import { db } from '../storage/db';

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

/** 2 (old) - 5 (fresh) — unlike a due date, a Teams message has no deadline; recency itself is the urgency signal (a DM from an hour ago is more pressing to answer than one from three days ago). Recomputed live every sync, not frozen at classification time. */
function teamsMessageUrgency(occurredAt: string): number {
  const ageMs = Date.now() - new Date(occurredAt).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageHours < 1) return 5;
  if (ageHours < 6) return 4;
  if (ageHours < 24) return 3;
  return 2;
}

/** Same recency bucketing as teamsMessageUrgency — kept separate rather than a shared helper to match this file's existing one-function-per-source style. */
function emailMessageUrgency(occurredAt: string): number {
  const ageMs = Date.now() - new Date(occurredAt).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageHours < 1) return 5;
  if (ageHours < 6) return 4;
  if (ageHours < 24) return 3;
  return 2;
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
    // Already approved by you — nothing left for you to do, so it shouldn't
    // keep occupying a review-request slot on the Dashboard. Not pushed to
    // `refs` either, so a previously-synced task for it gets pruned below
    // once you approve it.
    if (pr.myApprovalStatus === 'APPROVED') continue;
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

interface TriagedTeamsMessageRow {
  messageId: string;
  chatTitle: string | null;
  occurredAt: string;
  directedAtMe: number;
  summary: string;
  draftReply: string | null;
}

async function syncTeamsMessages(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT t.message_id AS messageId, em.title AS chatTitle, em.occurred_at AS occurredAt,
              t.directed_at_me AS directedAtMe, t.summary AS summary, t.draft_reply AS draftReply
       FROM teams_message_triage t
       JOIN external_messages em ON em.id = t.message_id`
    )
    .all() as TriagedTeamsMessageRow[];

  const refs: string[] = [];
  for (const row of rows) {
    refs.push(row.messageId);
    const directedAtMe = !!row.directedAtMe;
    const chatTitle = row.chatTitle ?? 'Unknown chat';
    upsertTask({
      source: 'teams_message',
      externalRef: row.messageId,
      title: `${directedAtMe ? 'Reply needed' : 'FYI'}: ${chatTitle}`,
      description: row.summary,
      url: null,
      dueDate: null,
      importanceScore: directedAtMe ? 4 : 2,
      urgencyScore: teamsMessageUrgency(row.occurredAt),
      draftReply: row.draftReply,
    });
  }
  pruneTasksForSource('teams_message', refs);
}

interface TriagedEmailMessageRow {
  messageId: string;
  subject: string | null;
  occurredAt: string;
  needsReply: number;
  summary: string;
  draftReply: string | null;
}

async function syncEmailMessages(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT t.message_id AS messageId, em.title AS subject, em.occurred_at AS occurredAt,
              t.needs_reply AS needsReply, t.summary AS summary, t.draft_reply AS draftReply
       FROM email_message_triage t
       JOIN external_messages em ON em.id = t.message_id`
    )
    .all() as TriagedEmailMessageRow[];

  const refs: string[] = [];
  for (const row of rows) {
    refs.push(row.messageId);
    const needsReply = !!row.needsReply;
    const subject = row.subject ?? 'No subject';
    upsertTask({
      source: 'email_message',
      externalRef: row.messageId,
      title: `${needsReply ? 'Reply needed' : 'FYI'}: ${subject}`,
      description: row.summary,
      url: null,
      dueDate: null,
      importanceScore: needsReply ? 4 : 2,
      urgencyScore: emailMessageUrgency(row.occurredAt),
      draftReply: row.draftReply,
    });
  }
  pruneTasksForSource('email_message', refs);
}

/**
 * Red builds Speako has already observed (src/dev/jenkinsMonitor.ts's
 * poller) surfaced onto My Plate — importance is higher for a build on one
 * of the developer's own dev-cycle branches than one merely being watched
 * with no cycle attached, since the former is squarely this developer's to
 * fix. Pruned automatically once a build goes green (getCurrentFailingBuilds
 * only returns the LATEST build per job, so a new passing build drops the
 * old failing ref from `refs` below).
 */
async function syncJenkins(): Promise<void> {
  if (!isJenkinsConfigured()) return;
  const failing = getCurrentFailingBuilds();
  const refs: string[] = [];
  for (const build of failing) {
    const ref = `${build.jobPath}#${build.buildNumber}`;
    refs.push(ref);
    upsertTask({
      source: 'jenkins_build',
      externalRef: ref,
      title: `Build failed: ${build.branchName ?? build.jobPath}`,
      description: build.classificationJson?.summary ?? `Build #${build.buildNumber} failed.`,
      url: build.url,
      dueDate: null,
      importanceScore: build.devCycleId ? 5 : 3,
      urgencyScore: 4,
    });
  }
  pruneTasksForSource('jenkins_build', refs);
}

/**
 * Fans out to every "what's on my plate" source and upserts them into the
 * unified tasks table — src/interface/server.ts's orchestrator poller (and
 * its manual "Sync now" route) call this. Promise.allSettled, not
 * Promise.all/for-of, so one source's total failure (e.g. Jira down) never
 * blocks the others from still syncing. Each connector already tolerates its own partial
 * failures internally (getPullRequestActivity's per-PR comment fetch,
 * getMyOpenJiraIssues' fail-to-empty-array on a bad response).
 */
export async function syncTasks(): Promise<{ synced: string[]; failed: string[] }> {
  const sources: { name: string; run: () => Promise<void> }[] = [
    { name: 'jira', run: syncJira },
    { name: 'bitbucket', run: syncBitbucket },
    { name: 'action_items', run: syncActionItems },
    { name: 'teams_messages', run: syncTeamsMessages },
    { name: 'email_messages', run: syncEmailMessages },
    { name: 'jenkins', run: syncJenkins },
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

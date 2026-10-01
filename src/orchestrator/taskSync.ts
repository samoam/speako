import { isJiraConfigured, getMyOpenJiraIssues, getJiraCommentMentions, JiraTaskMatch } from '../integrations/jiraMcp';
import { config } from '../config';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { getPullRequestActivity } from '../integrations/bitbucketReviews';
import { getAllOpenActionItems, ActionItemWithSession } from '../storage/summaryRepository';
import { upsertTask, pruneTasksForSource, getTaskByExternalRef, UpsertTaskInput, TaskSource } from '../storage/taskRepository';
import { askJev, isJevConfigured, jevChoice, URGENCY_QUESTION, URGENCY_SIGNALS, UrgencySignal } from '../integrations/typesafeJev';
import type { BitbucketPullRequest } from '../integrations/bitbucketServer';
import { getCurrentFailingBuilds } from '../storage/jenkinsBuildRepository';
import { isJenkinsConfigured } from '../integrations/jenkinsClient';
import { db } from '../storage/db';
import type { MessageUrgencySignal } from '../communications/teamsMessageTriage';
// emailTriage.ts declares its own identical MessageUrgencySignal type alias — structurally the same union, reused here rather than importing twice.

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

/** Case-insensitive membership check against config.vipSenders — shared across all four message sources (Teams/email sender, Jira/Bitbucket commenter) rather than four bespoke checks. */
function isVip(name: string | null | undefined): boolean {
  if (!name) return false;
  return config.vipSenders.includes(name.toLowerCase());
}

/** Applies the VIP importance bump (+1, capped at 5) uniformly wherever a sender/commenter name is available. */
function withVipBump(importance: number, name: string | null | undefined): number {
  return isVip(name) ? Math.min(5, importance + 1) : importance;
}

/**
 * ISO string for a source timestamp, or null. Confirmed live (2026-10-01)
 * that Jira's MCP server returns times like "2026-10-01 11:46:14 Eastern
 * Daylight Time", which Date can't parse (Invalid Date) — so Jira cards fell
 * back to "Added" and comment ages came out NaN. The zone name is dropped and
 * the rest read as local time: the Jira server and this machine share a zone
 * (America/Toronto), confirmed against the same issue's REST timestamp.
 */
export function toIsoTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!match) return null;
  const local = new Date(`${match[1]}T${match[2]}`);
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}

export function jiraIssueToTask(issue: JiraTaskMatch): UpsertTaskInput {
  return {
    source: 'jira',
    externalRef: issue.key,
    title: issue.key ? `${issue.key}: ${issue.summary}` : issue.summary,
    description: issue.statusName ? `Status: ${issue.statusName}` : null,
    url: issue.url,
    dueDate: issue.dueDate,
    importanceScore: jiraImportance(issue.priorityName),
    urgencyScore: urgencyFromDueDate(issue.dueDate),
    occurredAt: toIsoTime(issue.updated),
  };
}

/** 1 (fresh) - 5 (stale) — a review request sitting unreviewed longer is more urgent, not less. */
export function reviewRequestUrgency(createdDate: string | null): number {
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

/**
 * 2 (old) - 5 (fresh) recency baseline — unlike a due date, a Teams message
 * has no deadline; message age itself is the fallback urgency signal (a DM
 * from an hour ago is more pressing to answer than one from three days
 * ago). `urgencySignal` (teamsMessageTriage.ts's LLM-assessed classification
 * of the message TEXT itself) overrides/boosts that recency baseline:
 * 'urgent' forces the max regardless of age, 'soon' guarantees at least a
 * 4. Recomputed live every sync, not frozen at classification time.
 */
function messageUrgency(occurredAt: string, urgencySignal: MessageUrgencySignal): number {
  if (urgencySignal === 'urgent') return 5;
  const ageMs = Date.now() - new Date(occurredAt).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  const recency = ageHours < 1 ? 5 : ageHours < 6 ? 4 : ageHours < 24 ? 3 : 2;
  return urgencySignal === 'soon' ? Math.max(recency, 4) : recency;
}

/** 3 (fresh) - 5 (stale) — a comment sitting unread longer is more urgent, not less; deliberately narrower than messageUrgency's 2-5 range since a Jira comment is inherently lower-urgency than a direct chat/email. */
function jiraCommentUrgency(createdDate: string): number {
  const ageMs = Date.now() - new Date(createdDate).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays >= 2) return 5;
  if (ageDays >= 1) return 4;
  return 3;
}

/** Jev's read of a comment mention's own text — the cached value when this ref was classified before, a fresh Jev call otherwise, null if Jev isn't configured or fails (retried on the next sync). */
async function commentUrgencySignal(source: TaskSource, ref: string, text: string): Promise<UrgencySignal | null> {
  const cached = getTaskByExternalRef(source, ref)?.urgencySignal;
  if (cached) return cached as UrgencySignal;
  if (!isJevConfigured()) return null;
  try {
    const answers = await askJev(text, { urgency: URGENCY_QUESTION }, 'commentUrgency');
    return jevChoice(answers.urgency, URGENCY_SIGNALS);
  } catch (err: any) {
    console.error(`[task-sync] Jev urgency failed for ${ref}:`, err.message);
    return null;
  }
}

/** Same override rule messageUrgency applies to its recency baseline: 'urgent' forces the max, 'soon' guarantees at least a 4. */
function withUrgencySignal(base: number, signal: UrgencySignal | null): number {
  if (signal === 'urgent') return 5;
  if (signal === 'soon') return Math.max(base, 4);
  return base;
}

/**
 * Fans out to both "issues assigned to me" (getMyOpenJiraIssues) and — when
 * config.jiraUserIdentifier is set — "new comments on issues I'm
 * assigned to/watching" (getJiraCommentMentions), the same combined-refs
 * pattern syncBitbucket() below already uses for its own two comment/PR
 * shapes. Both must share ONE `refs` array and ONE pruneTasksForSource
 * call — a second, separate prune call scoped to only one of the two ref
 * shapes would delete the other's tasks as collateral on every sync.
 */
async function syncJira(): Promise<void> {
  if (!isJiraConfigured()) return;
  const refs: string[] = [];

  const issues = await getMyOpenJiraIssues();
  for (const issue of issues) {
    refs.push(issue.key);
    upsertTask(jiraIssueToTask(issue));
  }

  if (config.jiraUserIdentifier) {
    const mentions = await getJiraCommentMentions();
    for (const mention of mentions) {
      const ref = `${mention.issueKey}:comment:${mention.commentId}`;
      refs.push(ref);
      const urgencySignal = await commentUrgencySignal('jira', ref, mention.text);
      upsertTask({
        source: 'jira',
        externalRef: ref,
        title: `Comment on ${mention.issueKey}: ${mention.issueSummary}`,
        description: `${mention.authorName}: ${mention.text.slice(0, 300)}`,
        url: mention.url,
        dueDate: null,
        importanceScore: withVipBump(jiraImportance(mention.priorityName), mention.authorName),
        urgencyScore: withUrgencySignal(jiraCommentUrgency(toIsoTime(mention.createdDate) ?? mention.createdDate), urgencySignal),
        urgencySignal,
        occurredAt: toIsoTime(mention.createdDate),
      });
    }
  }

  pruneTasksForSource('jira', refs);
}

export type ReviewState = 'NEW' | 'NEEDS_WORK' | 'REWORKED';

/**
 * Bitbucket's own NEEDS_WORK/UNAPPROVED, plus REWORKED: you requested
 * changes and the author has pushed since (lastReviewedCommit no longer the
 * branch head). `previous` covers Bitbucket clearing NEEDS_WORK back to
 * UNAPPROVED on push, if the repo resets reviewer status on source updates —
 * not observed live yet, so without the remembered prior state that PR would
 * silently fall back to NEW.
 */
export function deriveReviewState(pr: Pick<BitbucketPullRequest, 'myApprovalStatus' | 'myLastReviewedCommit' | 'fromLatestCommit'>, previous: string | null | undefined): ReviewState {
  const pushedSinceReview = !!pr.myLastReviewedCommit && !!pr.fromLatestCommit && pr.myLastReviewedCommit !== pr.fromLatestCommit;
  if (pr.myApprovalStatus === 'NEEDS_WORK') return pushedSinceReview ? 'REWORKED' : 'NEEDS_WORK';
  if ((previous === 'NEEDS_WORK' || previous === 'REWORKED') && pushedSinceReview) return 'REWORKED';
  return 'NEW';
}

async function syncBitbucket(): Promise<void> {
  if (!isBitbucketConfigured()) return;
  const activity = await getPullRequestActivity();
  const refs: string[] = [];
  const reviewStateByPr = new Map<string, ReviewState>();

  for (const pr of activity.reviewRequests) {
    // Already approved by you — nothing left for you to do, so it shouldn't
    // keep occupying a review-request slot on the Dashboard. Not pushed to
    // `refs` either, so a previously-synced task for it gets pruned below
    // once you approve it.
    if (pr.myApprovalStatus === 'APPROVED') continue;
    const ref = `${pr.projectKey}/${pr.repoSlug}#${pr.id}`;
    refs.push(ref);
    const reviewState = deriveReviewState(pr, getTaskByExternalRef('bitbucket_pr', ref)?.myReviewStatus);
    reviewStateByPr.set(ref, reviewState);
    upsertTask({
      source: 'bitbucket_pr',
      externalRef: ref,
      title: `Review: ${pr.title}`,
      description: `${pr.projectKey}/${pr.repoSlug}#${pr.id} by ${pr.authorName} — your status: ${pr.myApprovalStatus ?? 'unknown'}`,
      url: pr.link,
      dueDate: null,
      importanceScore: 4,
      urgencyScore: reviewRequestUrgency(pr.createdDate),
      myReviewStatus: reviewState,
      occurredAt: pr.createdDate,
    });
  }

  // Three disjoint lists (bitbucketReviews.ts keeps each comment in one), all
  // with the same "<pr ref>:comment:<id>" externalRef shape that
  // bitbucketPrCommentReplyDraft.ts drafts replies for.
  const commentTasks = [
    ...activity.mentionsOfMe.map((comment) => ({ comment, title: `Mentioned in: ${comment.prTitle}` })),
    ...activity.repliesToMe.map((comment) => ({ comment, title: `Reply on: ${comment.prTitle}` })),
    ...activity.commentsOnMyPRs.map((comment) => ({ comment, title: `Comment on your PR: ${comment.prTitle}` })),
  ];
  for (const { comment, title } of commentTasks) {
    const ref = `${comment.projectKey}/${comment.repoSlug}#${comment.prId}:comment:${comment.commentId}`;
    refs.push(ref);
    const urgencySignal = await commentUrgencySignal('bitbucket_pr', ref, comment.text);
    upsertTask({
      source: 'bitbucket_pr',
      externalRef: ref,
      title,
      description: `${comment.authorName}: ${comment.text.slice(0, 300)}`,
      url: null,
      dueDate: null,
      importanceScore: withVipBump(3, comment.authorName),
      urgencyScore: withUrgencySignal(3, urgencySignal),
      urgencySignal,
      occurredAt: comment.createdDate,
      // A comment card shows its PR's review state too — null only when that
      // PR isn't one of your open review requests (e.g. your own PR).
      myReviewStatus: reviewStateByPr.get(`${comment.projectKey}/${comment.repoSlug}#${comment.prId}`) ?? null,
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
  urgencySignal: MessageUrgencySignal;
  participants: string | null;
}

/** Exported so a running Teams triage can surface each finished batch on the board right away (server.ts's runTeamsSync) — local DB only, unlike syncTasks' remote sources. */
export async function syncTeamsMessages(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT t.message_id AS messageId, em.title AS chatTitle, em.occurred_at AS occurredAt,
              t.directed_at_me AS directedAtMe, t.summary AS summary, t.draft_reply AS draftReply,
              t.urgency_signal AS urgencySignal, em.participants AS participants
       FROM teams_message_triage t
       JOIN external_messages em ON em.id = t.message_id`
    )
    .all() as TriagedTeamsMessageRow[];

  const refs: string[] = [];
  for (const row of rows) {
    refs.push(row.messageId);
    const directedAtMe = !!row.directedAtMe;
    const chatTitle = row.chatTitle ?? 'Unknown chat';
    const sender: string | undefined = row.participants ? JSON.parse(row.participants)[0] : undefined;
    upsertTask({
      source: 'teams_message',
      externalRef: row.messageId,
      title: `${directedAtMe ? 'Reply needed' : 'FYI'}: ${chatTitle}`,
      description: row.summary,
      url: null,
      dueDate: null,
      importanceScore: withVipBump(directedAtMe ? 4 : 2, sender),
      urgencyScore: messageUrgency(row.occurredAt, row.urgencySignal),
      draftReply: row.draftReply,
      occurredAt: row.occurredAt,
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
  urgencySignal: MessageUrgencySignal;
  participants: string | null;
}

/** Exported, like syncTeamsMessages, so an email sync can refresh just its own tasks instead of re-running every remote source (server.ts's runEmailSync). */
export async function syncEmailMessages(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT t.message_id AS messageId, em.title AS subject, em.occurred_at AS occurredAt,
              t.needs_reply AS needsReply, t.summary AS summary, t.draft_reply AS draftReply,
              t.urgency_signal AS urgencySignal, em.participants AS participants
       FROM email_message_triage t
       JOIN external_messages em ON em.id = t.message_id`
    )
    .all() as TriagedEmailMessageRow[];

  const refs: string[] = [];
  for (const row of rows) {
    refs.push(row.messageId);
    const needsReply = !!row.needsReply;
    const subject = row.subject ?? 'No subject';
    const sender: string | undefined = row.participants ? JSON.parse(row.participants)[0] : undefined;
    upsertTask({
      source: 'email_message',
      externalRef: row.messageId,
      title: `${needsReply ? 'Reply needed' : 'FYI'}: ${subject}`,
      description: row.summary,
      url: null,
      dueDate: null,
      importanceScore: withVipBump(needsReply ? 4 : 2, sender),
      urgencyScore: messageUrgency(row.occurredAt, row.urgencySignal),
      draftReply: row.draftReply,
      occurredAt: row.occurredAt,
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
/** Exported for the Jenkins poller, which only needs build tasks refreshed (local DB), not a full Jira/Bitbucket re-sync. */
export async function syncJenkins(): Promise<void> {
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
      occurredAt: build.startedAt,
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

import { config } from '../config';
import { BitbucketPullRequestComment, getPullRequest, getPullRequestComments, PrRef } from '../integrations/bitbucketServer';
import { DevCycle, closeDevCycle } from '../storage/devCycleRepository';
import { DevCycleFeedback, FeedbackThreadInput } from '../storage/devCycleFeedbackRepository';
import { startDraft } from '../drafts/draftService';
import { lifecycleTransitionSubjectId } from '../drafts/kinds/jiraTransitionDraft';
import { removeWorktree } from '../integrations/claudeCodeCli';

/**
 * The review-feedback half of the dev cycle: once the PR is open, reviewer
 * comments are turned into replies (and code changes when the comment is
 * right), posted after one human approval, and the cycle keeps going until
 * the PR is merged. This module is the pure/data side — what counts as
 * feedback, the triage and implementation prompts, and what the Bitbucket
 * sync does with a cycle's PR; the run itself is
 * src/orchestration/kinds/prFeedbackRun.ts.
 */

export function prRefOf(cycle: DevCycle): PrRef | null {
  if (!cycle.prId || !cycle.prProjectKey || !cycle.prRepoSlug) return null;
  return { id: cycle.prId, projectKey: cycle.prProjectKey, repoSlug: cycle.prRepoSlug };
}

/**
 * The threads on the PR that are waiting on the author: started by someone
 * else, and the reviewer had the last word. The author's own replies close a
 * thread for this purpose; a reviewer follow-up re-opens it. The text is the
 * whole thread so the triage sees the conversation, not just the opener.
 */
export function threadsNeedingResponse(comments: BitbucketPullRequestComment[], selfUsername: string): FeedbackThreadInput[] {
  const self = selfUsername.toLowerCase();
  const byRoot = new Map<number, BitbucketPullRequestComment[]>();
  for (const c of comments) byRoot.set(c.rootCommentId, [...(byRoot.get(c.rootCommentId) ?? []), c]);
  const threads: FeedbackThreadInput[] = [];
  for (const [rootCommentId, items] of byRoot) {
    const ordered = [...items].sort((a, b) => a.createdDate.localeCompare(b.createdDate));
    const root = ordered.find((c) => c.commentId === rootCommentId) ?? ordered[0];
    if (root.authorUsername.toLowerCase() === self) continue; // the author's own thread — reviewers reply there, not us
    const last = ordered[ordered.length - 1];
    if (last.authorUsername.toLowerCase() === self) continue; // we had the last word
    const text = ordered.map((c) => `${c.authorUsername.toLowerCase() === self ? 'me' : c.authorName}: ${c.text.trim()}`).join('\n');
    threads.push({ rootCommentId, author: root.authorName, text, anchorPath: repoPathOfAnchor(root.anchor?.path), anchorLine: root.anchor?.line ?? null });
  }
  return threads;
}

/** Confirmed live on PR #1825: an inline comment's anchor path can come back as `dst://<path>` (the diff side baked into the path); the triage needs the plain repo path. */
function repoPathOfAnchor(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.replace(/^(src|dst):\/\//, '');
}

export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'The feedback item id, exactly as given' },
          action: { type: 'string', enum: ['change', 'answer'], description: "'change' when the comment is right and the code should change; 'answer' when a reply settles it (a question, a misunderstanding, a disagreement worth explaining)" },
          reply: { type: 'string', description: 'The reply to post under the thread, in the first person, to the point, no sign-off' },
          changeInstruction: { type: 'string', description: "For 'change': precise instructions for the engineer making the change (file, what to change, why); empty otherwise" },
        },
        required: ['id', 'action', 'reply', 'changeInstruction'],
      },
    },
  },
  required: ['items'],
} as const;

export interface TriageResult {
  items: { id: number; action: 'change' | 'answer'; reply: string; changeInstruction: string }[];
}

/** Read-only pass over the code with the reviewer's threads: decide, per thread, whether it warrants a change or an answer, and draft the reply. */
export function buildTriagePrompt(params: { ticketKey: string; prTitle: string; branch: string; baseBranch: string; items: DevCycleFeedback[] }): string {
  const list = params.items
    .map((i) => `#${i.id} — ${i.author}${i.anchorPath ? ` on ${i.anchorPath}${i.anchorLine ? `:${i.anchorLine}` : ''}` : ' (general comment)'}:\n${i.text}`)
    .join('\n\n');
  return `You are the author of pull request "${params.prTitle}" (ticket ${params.ticketKey}, branch ${params.branch} into ${params.baseBranch}). You are checked out on the branch. Reviewers left the comment threads below; for each one, read the code they refer to and decide:

- "change": the reviewer is right (a bug, a real quality or convention problem, a missing case). Write a short reply acknowledging it and saying what will change, and give precise change instructions.
- "answer": a question, a misunderstanding, or a point you disagree with for a concrete reason. Write the reply that settles it — specific, referencing the code, no hedging and no filler.

Rules: never agree just to be agreeable, never dismiss a comment without a concrete reason, keep replies to a few sentences, do not modify any file in this pass.

Threads:

${list}`;
}

export function buildFeedbackChangesPrompt(params: { ticketKey: string; prTitle: string; items: DevCycleFeedback[] }): string {
  const list = params.items
    .map((i) => `- Thread #${i.id}${i.anchorPath ? ` (${i.anchorPath}${i.anchorLine ? `:${i.anchorLine}` : ''})` : ''}\n  Reviewer: ${i.text.split('\n')[0].slice(0, 400)}\n  Change to make: ${i.changeInstruction}`)
    .join('\n\n');
  return `Address the following review comments on pull request "${params.prTitle}" (ticket ${params.ticketKey}). Make exactly the changes described, nothing else, and keep each change minimal and consistent with the surrounding code.

${list}`;
}

export type PrWatchOutcome = { kind: 'merged' } | { kind: 'declined' } | { kind: 'open'; threads: FeedbackThreadInput[] };

/** A feedback or fix round may have re-created the cycle's worktree after the PR opened; nothing needs it once the PR is closed. */
async function removeCycleWorktrees(cycle: DevCycle): Promise<void> {
  for (const worktree of [cycle.worktreePath, cycle.worktreePathGemini]) {
    if (worktree) await removeWorktree(worktree, cycle.repoPath).catch((err: any) => console.error(`[pr-feedback] failed to remove worktree ${worktree}:`, err.message));
  }
}

/**
 * One look at a cycle's PR: merged → the cycle is done and the ticket moves
 * on (a gated Jira transition draft to QA Ready); declined → abandoned;
 * otherwise the threads currently waiting on the author.
 */
export async function watchDevCyclePr(cycle: DevCycle): Promise<PrWatchOutcome | null> {
  const ref = prRefOf(cycle);
  if (!ref) return null;
  const pr = await getPullRequest(ref.projectKey, ref.repoSlug, ref.id);
  if (pr.state === 'MERGED') {
    await removeCycleWorktrees(cycle);
    closeDevCycle(cycle.id, 'done');
    startDraft({ kind: 'jira_transition', subjectId: lifecycleTransitionSubjectId(cycle.id, 'QA Ready') }).catch((err: any) => {
      console.error(`[pr-feedback] failed to start the QA Ready transition draft for cycle ${cycle.id}:`, err.message);
    });
    return { kind: 'merged' };
  }
  if (pr.state === 'DECLINED') {
    await removeCycleWorktrees(cycle);
    closeDevCycle(cycle.id, 'abandoned');
    return { kind: 'declined' };
  }
  const comments = await getPullRequestComments({ ...ref, title: pr.title });
  return { kind: 'open', threads: threadsNeedingResponse(comments, config.bitbucketServerUsername) };
}

import { getPullRequestsForRole, getPullRequestComments, BitbucketPullRequestComment } from './bitbucketServer';
import { config } from '../config';

/**
 * Bitbucket Server has no true global "search comments where I'm mentioned"
 * endpoint — there's no cross-repo comment search at all on this instance
 * (see bitbucketServer.ts's own comment on why searchBitbucketServer falls
 * back to commit messages). So "mentioned in comments" is scoped to comments
 * on pull requests I'm already involved in (authored, or asked to review) —
 * a real limitation, not a full mention search, but covers the realistic
 * case: people don't often @-mention you on a PR you have zero involvement in.
 */
function mentionsMe(comment: BitbucketPullRequestComment): boolean {
  const needle = `@${config.bitbucketServerUsername}`.toLowerCase();
  return comment.text.toLowerCase().includes(needle);
}

export interface PullRequestActivity {
  /** Open PRs where I'm a requested reviewer, with my current approval status. */
  reviewRequests: import('./bitbucketServer').BitbucketPullRequest[];
  /** Comments on PRs I authored (excluding any that also match mentionsMe, to avoid duplicating them in both lists). */
  commentsOnMyPRs: BitbucketPullRequestComment[];
  /** Comments mentioning me by @username, across PRs I authored or am reviewing. */
  mentionsOfMe: BitbucketPullRequestComment[];
}

/** One combined lookup — reviewer status + PR comments/mentions — for the voice tool and prep workflows to both consume. Ignores its query/limit params (matches webSearch's precedent in toolCatalog.ts): this is a fixed "what's my current PR activity" view, not a keyword search. */
export async function getPullRequestActivity(): Promise<PullRequestActivity> {
  const [reviewRequests, myPRs] = await Promise.all([
    getPullRequestsForRole('REVIEWER', 'OPEN'),
    getPullRequestsForRole('AUTHOR', 'OPEN'),
  ]);

  const commentSources = [...reviewRequests, ...myPRs];
  const commentLists = await Promise.all(
    commentSources.map((pr) =>
      getPullRequestComments(pr).catch((err: any) => {
        console.error(`[bitbucket] failed to fetch comments for PR ${pr.projectKey}/${pr.repoSlug}#${pr.id}:`, err.message);
        return [] as BitbucketPullRequestComment[];
      })
    )
  );
  const allComments = commentLists.flat();

  const mentionsOfMe = allComments.filter(mentionsMe);
  const myPrIds = new Set(myPRs.map((pr) => pr.id));
  const commentsOnMyPRs = allComments.filter((c) => myPrIds.has(c.prId) && !mentionsMe(c));

  return { reviewRequests, commentsOnMyPRs, mentionsOfMe };
}

function formatComment(c: BitbucketPullRequestComment): string {
  return `${c.projectKey}/${c.repoSlug}#${c.prId} "${c.prTitle}" — ${c.authorName}: ${c.text.slice(0, 300)}`;
}

/** Human-readable text block — what the voice tool returns and what feeds into prep briefs via toolCatalog.ts. */
export async function formatPullRequestActivity(): Promise<string> {
  const activity = await getPullRequestActivity();
  const parts: string[] = [];

  if (activity.reviewRequests.length) {
    parts.push(
      'PRs assigned to you for review:\n' +
        activity.reviewRequests
          .map((pr) => `- ${pr.projectKey}/${pr.repoSlug}#${pr.id} "${pr.title}" by ${pr.authorName} — your status: ${pr.myApprovalStatus ?? 'unknown'}`)
          .join('\n')
    );
  }
  if (activity.mentionsOfMe.length) {
    parts.push('Comments mentioning you:\n' + activity.mentionsOfMe.map(formatComment).join('\n'));
  }
  if (activity.commentsOnMyPRs.length) {
    parts.push('Other comments on your pull requests:\n' + activity.commentsOnMyPRs.map(formatComment).join('\n'));
  }

  return parts.join('\n\n');
}

import { getJiraIssueByKey, extractIssueKeys } from '../integrations/jiraMcp';
import { getPullRequest } from '../integrations/bitbucketServer';
import { upsertTask, getTaskByExternalRef, Task } from '../storage/taskRepository';
import { jiraIssueToTask, reviewRequestUrgency, deriveReviewState } from './taskSync';

export class ManualTaskNotFoundError extends Error {}
export class ManualTaskRefError extends Error {}

const BITBUCKET_PR_REF = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

export type ParsedManualTaskRef =
  | { kind: 'jira'; key: string }
  | { kind: 'bitbucket_pr'; projectKey: string; repoSlug: string; pullRequestId: number };

/**
 * Accepts either a bare Jira key ("ETICK-10052", case-insensitive on input
 * but normalized to the key's own casing via extractIssueKeys) or a
 * Bitbucket Server PR ref in the same "project/repo#id" shape
 * syncBitbucket()/upsertTask already use for bitbucket_pr's externalRef
 * (e.g. "GTEE/officercc#1651") — whatever format the Dashboard's task board
 * displays a PR reference in, so a user copy-pasting one back in round-trips.
 */
export function parseManualTaskRef(raw: string): ParsedManualTaskRef {
  const ref = raw.trim();
  if (!ref) {
    throw new ManualTaskRefError('Enter a Jira issue key (e.g. ETICK-10052) or a Bitbucket PR (e.g. PROJECT/repo#123).');
  }

  const prMatch = ref.match(BITBUCKET_PR_REF);
  if (prMatch) {
    const [, projectKey, repoSlug, prId] = prMatch;
    return { kind: 'bitbucket_pr', projectKey, repoSlug, pullRequestId: Number(prId) };
  }

  const [key] = extractIssueKeys(ref.toUpperCase());
  if (key) {
    return { kind: 'jira', key };
  }

  throw new ManualTaskRefError(
    `"${raw}" doesn't look like a Jira issue key (e.g. ETICK-10052) or a Bitbucket PR (e.g. PROJECT/repo#123).`
  );
}

/**
 * Fetches the referenced Jira issue or Bitbucket PR and adds/refreshes it as
 * a manually_added task (src/storage/taskRepository.ts) — the counterpart to
 * syncJira()/syncBitbucket() in taskSync.ts for a ticket/PR the automatic
 * sync wouldn't otherwise surface (not assigned to the user / not a review
 * request of theirs). Throws ManualTaskRefError for an unparseable ref and
 * ManualTaskNotFoundError when the referenced issue/PR genuinely doesn't
 * exist (or isn't visible with the configured credentials) — the server
 * route maps these to 400/404 respectively.
 */
export async function addManualTask(raw: string): Promise<Task> {
  const parsed = parseManualTaskRef(raw);

  if (parsed.kind === 'jira') {
    const issue = await getJiraIssueByKey(parsed.key);
    if (!issue) {
      throw new ManualTaskNotFoundError(`No Jira issue found for "${parsed.key}".`);
    }
    upsertTask({ ...jiraIssueToTask(issue), manuallyAdded: true });
    return getTaskByExternalRef('jira', parsed.key)!;
  }

  let pr;
  try {
    pr = await getPullRequest(parsed.projectKey, parsed.repoSlug, parsed.pullRequestId);
  } catch (err: any) {
    throw new ManualTaskNotFoundError(
      `No Bitbucket PR found for "${parsed.projectKey}/${parsed.repoSlug}#${parsed.pullRequestId}": ${err.message}`
    );
  }
  const externalRef = `${parsed.projectKey}/${parsed.repoSlug}#${parsed.pullRequestId}`;
  upsertTask({
    source: 'bitbucket_pr',
    externalRef,
    title: pr.title,
    description: `${externalRef} by ${pr.authorName}`,
    url: pr.link || null,
    dueDate: null,
    importanceScore: 4,
    urgencyScore: reviewRequestUrgency(pr.createdDate),
    manuallyAdded: true,
    myReviewStatus: deriveReviewState(pr, getTaskByExternalRef('bitbucket_pr', externalRef)?.myReviewStatus),
  });
  return getTaskByExternalRef('bitbucket_pr', externalRef)!;
}

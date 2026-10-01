import { BitbucketPullRequest, BitbucketPullRequestComment, getPullRequestComments } from '../../integrations/bitbucketServer';
import { createWorktreeForBranch, removeWorktree, runClaudeCodeReview } from '../../integrations/claudeCodeCli';
import { runSecondOpinionReview } from '../../integrations/antigravityCli';
import { gatherReviewContext, buildReviewPrompt, mergeReviews, recommendWithJev, REVIEW_JSON_SCHEMA, PrReviewContext } from '../../summarization/prReviewContext';
import {
  PrReviewRequest,
  StructuredReview,
  getPrReviewRequest,
  setPrReviewContext,
  setPrReviewRunId,
  markPrReviewReady,
  markPrReviewFailed,
} from '../../storage/prReviewRequestRepository';
import { getRun, getRunLog } from '../../storage/runRepository';
import { registerRunKind, startRun, withTimeout } from '../engine';
import { RunDefinition, StepEntry } from '../types';

export const PR_REVIEW_RUN_KIND = 'pr_review';

const CONTEXT_TIMEOUT_MS = 2 * 60 * 1000;
const COMMENTS_TIMEOUT_MS = 60 * 1000;
const WORKTREE_TIMEOUT_MS = 10 * 60 * 1000;
/** The reviewers each time out at 30 min internally (claudeCodeCli.ts / antigravityCli.ts) — this is the backstop in case one of those hangs on exit. */
const REVIEW_STEP_TIMEOUT_MS = 35 * 60 * 1000;

export interface PrReviewRunState {
  taskId: number;
  requestId: number;
  repoPath: string;
  pr: BitbucketPullRequest;
  secondOpinionEnabled: boolean;
  context?: PrReviewContext;
  existingComments?: BitbucketPullRequestComment[];
  worktreePath?: string | null;
  secondOpinionText?: string | null;
  /** Claude's review first; mergeReviews/recommendWithJev refine it in place. */
  review?: StructuredReview;
}

/**
 * The review pipeline as a run (see ../engine.ts). The step list is fixed
 * up front so the UI shows the whole checklist immediately; Claude and the
 * second opinion are separate parallel steps (each with its own live
 * detail) so a user can tell which of the two is still working. The
 * `gemini_review`/`merge` keys are kept from the pre-engine implementation
 * (see antigravityCli.ts for why it's Antigravity now, not the gemini CLI).
 */
function steps(state: PrReviewRunState): StepEntry<PrReviewRunState>[] {
  const entries: StepEntry<PrReviewRunState>[] = [
    {
      key: 'context',
      label: 'Gather PR & ticket context',
      async run(ctx) {
        const { pr } = ctx.state;
        ctx.log(`Fetched PR details — source branch "${pr.fromRefDisplayId}", opened by ${pr.authorName}.`);
        ctx.log('Checking linked Jira ticket(s) and related Confluence docs…');
        // Context is helpful, not required — a hung lookup must not sink the review.
        const context = await withTimeout(gatherReviewContext(pr), CONTEXT_TIMEOUT_MS, 'Gathering ticket context').catch((err: any) => {
          ctx.log(`${err.message} — continuing without ticket context.`);
          return { jiraIssues: [], confluencePages: [] } as PrReviewContext;
        });
        ctx.state.context = context;
        setPrReviewContext(ctx.state.requestId, {
          authorName: pr.authorName,
          jiraIssues: context.jiraIssues.map((i) => ({ key: i.key, summary: i.summary, status: i.status })),
          confluencePages: context.confluencePages.map((p) => ({ title: p.title })),
        });
        ctx.log(
          context.jiraIssues.length || context.confluencePages.length
            ? `Found ${context.jiraIssues.length} Jira ticket(s) and ${context.confluencePages.length} Confluence page(s).`
            : 'No linked Jira ticket or related Confluence docs found.'
        );
        // Existing comments (human, or from a prior automated review) go into
        // the prompt so the review doesn't repeat feedback already raised.
        const existingComments = await withTimeout(getPullRequestComments(pr), COMMENTS_TIMEOUT_MS, 'Fetching existing PR comments').catch((err: any) => {
          ctx.log(`${err.message} — continuing without them.`);
          return [] as BitbucketPullRequestComment[];
        });
        ctx.state.existingComments = existingComments;
        if (existingComments.length) ctx.log(`Found ${existingComments.length} existing comment(s) on this PR — the review will avoid repeating them.`);
        return `${context.jiraIssues.length} Jira ticket(s), ${context.confluencePages.length} Confluence page(s), ${existingComments.length} existing comment(s).`;
      },
    },
    {
      key: 'worktree',
      label: 'Check out branch',
      timeoutMs: WORKTREE_TIMEOUT_MS,
      async run(ctx) {
        const branch = ctx.state.pr.fromRefDisplayId!;
        ctx.log(`Checking out ${branch} into an isolated worktree…`);
        ctx.state.worktreePath = await createWorktreeForBranch(ctx.state.repoPath, branch);
        ctx.log(
          state.secondOpinionEnabled
            ? 'Worktree ready — running the Claude Code review and an Antigravity second opinion in parallel (this can take a few minutes)…'
            : 'Worktree ready — running the Claude Code review (this can take a few minutes)…'
        );
        return `Checked out ${branch}.`;
      },
    },
  ];

  const reviewers: StepEntry<PrReviewRunState> = [
    {
      key: 'claude_review',
      label: 'Run Claude Code review',
      timeoutMs: REVIEW_STEP_TIMEOUT_MS,
      async run(ctx) {
        const prompt = buildReviewPrompt(ctx.state.pr, ctx.state.context!, ctx.state.existingComments ?? []);
        const result = await runClaudeCodeReview(prompt, ctx.state.worktreePath!, {
          jsonSchema: REVIEW_JSON_SCHEMA,
          model: 'opus',
          onProgress: (message) => {
            ctx.log(message);
            ctx.detail(message);
          },
        });
        if (result.isError || !result.structuredOutput) {
          throw new Error(result.isError ? result.resultText || 'Claude Code returned an error.' : 'Claude Code did not return a structured result.');
        }
        // Watermarked 'claude' so a solo review's findings still carry a
        // source — mergeReviews overwrites this with per-finding tags.
        ctx.state.review = {
          ...result.structuredOutput,
          findings: result.structuredOutput.findings.map((f: any) => ({ ...f, source: 'claude' })),
        };
        return ctx.state.review!.summary;
      },
    },
  ];
  if (state.secondOpinionEnabled) {
    reviewers.push({
      key: 'gemini_review',
      label: 'Run Antigravity second opinion',
      optional: true,
      timeoutMs: REVIEW_STEP_TIMEOUT_MS,
      async run(ctx) {
        const prompt = buildReviewPrompt(ctx.state.pr, ctx.state.context!, ctx.state.existingComments ?? []);
        const result = await runSecondOpinionReview(prompt, ctx.state.worktreePath!, (message) => {
          ctx.log(message);
          ctx.detail(message);
        });
        if (result.isError) throw new Error(result.resultText || 'Antigravity returned an error.');
        ctx.state.secondOpinionText = result.resultText;
        return result.resultText.slice(0, 300);
      },
    });
  }
  entries.push(reviewers);

  if (state.secondOpinionEnabled) {
    entries.push({
      key: 'merge',
      label: 'Merge Claude + second-opinion reviews',
      optional: true, // a failed merge keeps the Claude-only review rather than losing the whole run
      async run(ctx) {
        if (!ctx.state.secondOpinionText) return 'Skipped — no second opinion to merge.';
        ctx.log('Merging the Claude Code review and the Antigravity second opinion…');
        ctx.state.review = await mergeReviews(ctx.state.review!, ctx.state.secondOpinionText);
        return ctx.state.review.summary;
      },
    });
  }

  entries.push({
    key: 'recommend',
    label: 'Final recommendation',
    optional: true,
    async run(ctx) {
      const review = ctx.state.review!;
      const jevRecommendation = await recommendWithJev(review);
      if (jevRecommendation && jevRecommendation !== review.recommendation) {
        ctx.log(`Jev recommends "${jevRecommendation}" (reviewer suggested "${review.recommendation}") — using Jev's pick.`);
        ctx.state.review = { ...review, recommendation: jevRecommendation };
      }
      ctx.log('Review complete.');
      return ctx.state.review!.recommendation;
    },
  });

  return entries;
}

export const prReviewRunDefinition: RunDefinition<PrReviewRunState> = {
  kind: PR_REVIEW_RUN_KIND,
  steps,
  async finalize(run, outcome, error) {
    const { requestId, review, worktreePath, repoPath } = run.state;
    if (outcome === 'done' && review) markPrReviewReady(requestId, review);
    else markPrReviewFailed(requestId, error ?? 'Review did not produce a result.');
    if (worktreePath) {
      try {
        await removeWorktree(worktreePath, repoPath);
      } catch (err: any) {
        console.error('[pr-review] failed to remove worktree:', err.message);
      }
    }
  },
};

registerRunKind(prReviewRunDefinition);

/** Creates the run for an already-created request row and links the two; the engine starts it as soon as a worker slot is free. */
export function startPrReviewRun(params: { request: PrReviewRequest; pr: BitbucketPullRequest; repoPath: string; secondOpinionEnabled: boolean }): number {
  const run = startRun<PrReviewRunState>({
    kind: PR_REVIEW_RUN_KIND,
    subjectKind: 'task',
    subjectId: String(params.request.taskId),
    state: { taskId: params.request.taskId, requestId: params.request.id, repoPath: params.repoPath, pr: params.pr, secondOpinionEnabled: params.secondOpinionEnabled },
  });
  setPrReviewRunId(params.request.id, run.id);
  return run.id;
}

/**
 * What GET /api/plate/:id/review returns: the request row with `phases`/`log`
 * read from its run — the shape index.html's renderPrReview has always
 * consumed. Rows that predate runs (run_id IS NULL) keep their own columns.
 */
export function prReviewRequestView(request: PrReviewRequest): PrReviewRequest {
  if (!request.runId) return request;
  const run = getRun(request.runId);
  if (!run) return request;
  return { ...request, phases: run.steps, log: getRunLog(run.id) };
}

export function getPrReviewRequestView(id: number): PrReviewRequest | undefined {
  const request = getPrReviewRequest(id);
  return request && prReviewRequestView(request);
}

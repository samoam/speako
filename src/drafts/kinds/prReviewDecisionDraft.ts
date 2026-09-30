import { generateJson, hasTextProvider, NO_TEXT_PROVIDER_MESSAGE } from '../../ai/aiRouter';
import { getPrReviewRequest, PrReviewRequest, PrReviewRecommendation } from '../../storage/prReviewRequestRepository';
import { getTaskById, dismissTask, setTaskMyReviewStatus } from '../../storage/taskRepository';
import { addPullRequestComment, setPullRequestParticipantStatus, PullRequestParticipantStatus, PrRef } from '../../integrations/bitbucketServer';
import { buildRefinementBlock, REFINE_ENVELOPE_SCHEMA } from '../refinePrompt';
import { PR_REF_PATTERN } from './bitbucketPrCommentDraft';
import { DraftHandler } from '../types';

export interface PrReviewDecisionContent {
  status: PullRequestParticipantStatus;
  /** Optional — a decision can post with no comment (e.g. a plain Approve). */
  text: string;
}

export interface PrReviewDecisionSubject {
  request: PrReviewRequest;
  pr: PrRef;
}

/** Mirrors REVIEW_RECOMMENDATION_LABELS' 3-way choice (index.html) onto Bitbucket's 3-way participant status — the AI's own recommendation pre-fills the control, left fully overridable by the user before posting. */
const RECOMMENDATION_TO_STATUS: Record<PrReviewRecommendation, PullRequestParticipantStatus> = {
  approve: 'APPROVED',
  request_changes: 'NEEDS_WORK',
  comment: 'UNAPPROVED',
};

function loadPrRef(request: PrReviewRequest): PrRef | undefined {
  const task = getTaskById(request.taskId);
  const match = task?.externalRef.match(PR_REF_PATTERN);
  if (!match) return undefined;
  const [, projectKey, repoSlug, prId] = match;
  return { projectKey, repoSlug, id: Number(prId) };
}

/**
 * The approve/needs-work/unapprove decision for a PR review
 * (src/summarization/prReviewContext.ts's already-computed recommendation),
 * plus an optional review comment posted alongside it — gated through the
 * same refine/approve/execute lifecycle as bitbucketPrCommentDraft.ts's
 * per-finding comments, but one draft per review run rather than one per
 * finding (subjectId is just the pr_review_request id, no composite needed).
 * Like jiraTransitionDraft's toState, `status` is a fixed enum the frontend
 * lets the user pick directly (draftKindMeta's <select>, index.html) rather
 * than something chat refinement can silently change; only `text` goes
 * through the AI rewrite path.
 */
export const prReviewDecisionDraft: DraftHandler<PrReviewDecisionSubject> = {
  kind: 'pr_review_decision',
  subjectKind: 'pr_review_request',
  gates: [{ key: 'post', label: 'Post to Bitbucket' }],
  redoStrategy: 'follow_up',
  loadSubject(subjectId) {
    const requestId = Number(subjectId);
    if (!Number.isFinite(requestId)) return undefined;
    const request = getPrReviewRequest(requestId);
    if (!request || !request.review) return undefined;
    const pr = loadPrRef(request);
    if (!pr) return undefined;
    return { request, pr };
  },
  async generate(input) {
    const { request } = input.subject;

    if (input.redo) {
      const priorContent = input.redo.priorContent as PrReviewDecisionContent;
      return { mode: 'draft', content: { ...priorContent, text: input.redo.instruction || priorContent.text } };
    }

    if (input.instruction) {
      // Only the comment text is refinable via chat — status is a direct
      // user pick in the draft panel's <select>, same split jiraTransitionDraft
      // draws between its fixed toState and its freely-refinable comment.
      if (!hasTextProvider()) throw new Error(NO_TEXT_PROVIDER_MESSAGE);
      const priorContent = input.priorContent as PrReviewDecisionContent;
      const refinementBlock = buildRefinementBlock(input.history, priorContent.text);
      const prompt = `You are helping refine a drafted Bitbucket pull-request review comment (to be posted alongside a review decision) through a chat-style conversation with the reviewer about to post it.

${refinementBlock}

The user's newest instruction: ${JSON.stringify(input.instruction)}

If they're asking for a CHANGE, return the full revised comment text. An empty string is valid — it means "post the decision with no comment". If they're asking a QUESTION about the comment or the recommendation, answer it directly and leave the comment as-is.`;
      const parsed = await generateJson<any>('draft', 'refinePrReviewDecision', prompt, REFINE_ENVELOPE_SCHEMA);
      if (parsed.action === 'answer') {
        return { mode: 'answer', text: parsed.answer || "I don't have anything more specific to add." };
      }
      return { mode: 'draft', content: { ...priorContent, text: parsed.draftText ?? priorContent.text }, note: parsed.note };
    }

    // First generation — seed status from the AI review's own recommendation
    // and text from its summary, both freely overridable before posting.
    const review = request.review!;
    return {
      mode: 'draft',
      content: { status: RECOMMENDATION_TO_STATUS[review.recommendation], text: review.summary ?? '' },
    };
  },
  async execute(_gateKey, ctx) {
    const { pr, request } = ctx.subject;
    const content = ctx.content as PrReviewDecisionContent;
    let commentId: number | undefined;
    if (content.text?.trim()) {
      const posted = await addPullRequestComment(pr, { text: content.text });
      commentId = posted.id;
    }
    await setPullRequestParticipantStatus(pr, content.status);
    setTaskMyReviewStatus(request.taskId, content.status === 'NEEDS_WORK' ? 'NEEDS_WORK' : 'NEW');
    // Confirmed live: this task's review-request row is referenced by
    // pr_review_requests, which pruneTasksForSource (taskSync.ts's periodic
    // Bitbucket sync) can never hard-delete (FK constraint) — so without
    // this, an approved PR sat in the open queue until Bitbucket's own
    // myApprovalStatus caught up on the next sync AND that sync's dismiss
    // path ran, rather than disappearing the moment you approve it here.
    if (content.status === 'APPROVED') dismissTask(request.taskId);
    return { status: content.status, commentId };
  },
  legacyBroadcast(_draft, phase) {
    if (phase === 'completed') return [{ type: 'plate-updated' }];
  },
};

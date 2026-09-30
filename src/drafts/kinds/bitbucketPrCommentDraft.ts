import { generateJson, hasTextProvider, NO_TEXT_PROVIDER_MESSAGE } from '../../ai/aiRouter';
import { getPrReviewRequest, PrReviewRequest, PrReviewFinding } from '../../storage/prReviewRequestRepository';
import { getTaskById } from '../../storage/taskRepository';
import { getPullRequestChangedPaths, getPullRequestDiffAnchors, addPullRequestComment, BitbucketCommentAnchor } from '../../integrations/bitbucketServer';
import { resolveFindingAnchor, formatRetractionComment } from '../../summarization/prReviewComments';
import { buildRefinementBlock, REFINE_ENVELOPE_SCHEMA } from '../refinePrompt';
import { DraftHandler } from '../types';

export interface PrCommentContent {
  text: string;
  mode: 'inline' | 'file' | 'general';
  anchor: BitbucketCommentAnchor | null;
  anchorWarning: string | null;
}

export interface PrCommentSubject {
  request: PrReviewRequest;
  pr: { projectKey: string; repoSlug: string; id: number };
  finding: PrReviewFinding;
  findingIndex: number;
}

/** subjectId is "<prReviewRequestId>:<findingIndex>" — a single review can stage many comments, one per finding, so (like jira_transition's composite id) the plain request id alone isn't specific enough to name ONE draft's subject. */
function parseSubjectId(subjectId: string): { requestId: number; findingIndex: number } | null {
  const separatorIndex = subjectId.lastIndexOf(':');
  if (separatorIndex === -1) return null;
  const requestId = Number(subjectId.slice(0, separatorIndex));
  const findingIndex = Number(subjectId.slice(separatorIndex + 1));
  if (!Number.isFinite(requestId) || !Number.isInteger(findingIndex) || findingIndex < 0) return null;
  return { requestId, findingIndex };
}

export function prCommentSubjectId(prReviewRequestId: number, findingIndex: number): string {
  return `${prReviewRequestId}:${findingIndex}`;
}

export const PR_REF_PATTERN = /^([^/]+)\/([^#]+)#(\d+)/;

/**
 * Bitbucket PR review comments — findings from an already-completed
 * read-only review (src/summarization/prReviewContext.ts) staged one draft
 * per finding, gated through the same refine/approve/redo lifecycle as
 * every other write in this app, rather than the old "never auto-posted,
 * period" restriction.
 */
export const bitbucketPrCommentDraft: DraftHandler<PrCommentSubject> = {
  kind: 'bitbucket_pr_comment',
  subjectKind: 'pr_review_request',
  gates: [{ key: 'post', label: 'Post to Bitbucket' }],
  redoStrategy: 'follow_up',
  loadSubject(subjectId) {
    const parsed = parseSubjectId(subjectId);
    if (!parsed) return undefined;
    const request = getPrReviewRequest(parsed.requestId);
    if (!request || !request.review) return undefined;
    const finding = request.review.findings[parsed.findingIndex];
    if (!finding) return undefined;
    const task = getTaskById(request.taskId);
    const match = task?.externalRef.match(PR_REF_PATTERN);
    if (!match) return undefined;
    const [, projectKey, repoSlug, prId] = match;
    return { request, pr: { projectKey, repoSlug, id: Number(prId) }, finding, findingIndex: parsed.findingIndex };
  },
  async generate(input) {
    const { pr, finding } = input.subject;

    if (input.redo) {
      const priorContent = input.redo.priorContent as PrCommentContent;
      const reason = input.redo.instruction || 'this needs a correction';
      return {
        mode: 'draft',
        content: { ...priorContent, text: formatRetractionComment({ file: finding.file, line: finding.line }, reason), mode: 'general', anchor: null },
      };
    }

    if (input.instruction) {
      if (!hasTextProvider()) throw new Error(NO_TEXT_PROVIDER_MESSAGE);
      const priorContent = input.priorContent as PrCommentContent;
      const refinementBlock = buildRefinementBlock(input.history, priorContent.text);
      const prompt = `You are helping refine a drafted Bitbucket pull-request review comment through a chat-style conversation with the reviewer about to post it.

${refinementBlock}

The user's newest instruction: ${JSON.stringify(input.instruction)}

If they're asking for a CHANGE, return the full revised comment text. If they're asking a QUESTION about the comment or why it was flagged, answer it directly and leave the comment as-is.`;
      const parsed = await generateJson<any>('draft', 'refinePrComment', prompt, REFINE_ENVELOPE_SCHEMA);
      if (parsed.action === 'answer') {
        return { mode: 'answer', text: parsed.answer || "I don't have anything more specific to add." };
      }
      return { mode: 'draft', content: { ...priorContent, text: parsed.draftText || priorContent.text }, note: parsed.note };
    }

    // First generation — re-fetch changed paths/diff anchors fresh from
    // Bitbucket (the review's own worktree is already gone by staging time,
    // see server.ts's stage route), then resolve inline vs file vs general.
    const changedPaths = await getPullRequestChangedPaths(pr);
    const anchors = changedPaths.includes(finding.file) ? await getPullRequestDiffAnchors(pr, finding.file) : [];
    const { mode, anchor, warning } = resolveFindingAnchor(finding, changedPaths, anchors);
    const text = mode === 'general' ? `\`${finding.file}${finding.line != null ? ':' + finding.line : ''}\` — ${finding.comment}` : finding.comment;
    return { mode: 'draft', content: { text, mode, anchor, anchorWarning: warning } };
  },
  async execute(_gateKey, ctx) {
    const { pr } = ctx.subject;
    const content = ctx.content as PrCommentContent;
    // Posted exactly as drafted — no AI-disclosure trailer appended (see
    // SPEAKO_COMMENT_MARKER's comment in prReviewComments.ts for why that
    // existed before and why it's gone now).
    const posted = await addPullRequestComment(pr, { text: content.text, anchor: content.anchor ?? undefined });
    return { commentId: posted.id, version: posted.version, mode: content.mode };
  },
  legacyBroadcast(draft) {
    const parsed = parseSubjectId(draft.subjectId);
    return parsed ? [{ type: 'pr-comment-drafts-updated', prReviewRequestId: parsed.requestId }] : undefined;
  },
};

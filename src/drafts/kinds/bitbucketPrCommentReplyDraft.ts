import { Task, getTaskById, dismissTask } from '../../storage/taskRepository';
import { Draft } from '../../storage/draftRepository';
import { DraftHandler } from '../types';
import { addPullRequestComment } from '../../integrations/bitbucketServer';
import { generateReplyDraft, ReplyDraftContent } from './replyDraftShared';

/** "<projectKey>/<repoSlug>#<prId>:comment:<commentId>" — the shape taskSync.ts's syncBitbucket() gives mentionsOfMe tasks. */
const COMMENT_REF_PATTERN = /^([^/]+)\/([^#]+)#(\d+):comment:(\d+)$/;

/**
 * Bitbucket PR comment-reply drafts — same generateReplyDraft-based shape as
 * teamsReplyDraft.ts/emailReplyDraft.ts/jiraCommentReplyDraft.ts. Distinct
 * from bitbucketPrCommentDraft.ts (kind: 'bitbucket_pr_comment'), which
 * posts a fresh AI-review finding, not a reply to an existing comment —
 * this one always threads under the original via addPullRequestComment's
 * parentId, a genuine Bitbucket Server reply rather than a new top-level
 * comment.
 */
export const bitbucketPrCommentReplyDraft: DraftHandler<Task> = {
  kind: 'bitbucket_pr_comment_reply',
  subjectKind: 'task',
  gates: [{ key: 'post', label: 'Post reply to Bitbucket' }],
  redoStrategy: 'follow_up',
  loadSubject(subjectId) {
    const task = getTaskById(Number(subjectId));
    if (!task || task.source !== 'bitbucket_pr' || !COMMENT_REF_PATTERN.test(task.externalRef)) return undefined;
    return task;
  },
  generate: (input) =>
    generateReplyDraft(input, {
      logLabel: 'draftBitbucketPrCommentReply',
      channelLabel: 'Bitbucket PR comment',
      toneHint: 'concise and professional',
    }),
  async execute(_gateKey, ctx) {
    const content = ctx.content as ReplyDraftContent;
    const match = ctx.subject.externalRef.match(COMMENT_REF_PATTERN);
    if (!match) throw new Error(`Malformed Bitbucket PR comment task ref: ${ctx.subject.externalRef}`);
    const [, projectKey, repoSlug, prId, commentId] = match;
    const posted = await addPullRequestComment(
      { projectKey, repoSlug, id: Number(prId) },
      { text: content.text, parentId: Number(commentId) }
    );
    // Reply actually posted — this task is done, drop it from the queue
    // the same way an explicit Dismiss would.
    dismissTask(ctx.subject.id);
    return { text: content.text, at: new Date().toISOString(), channel: 'bitbucket', commentId: posted.id };
  },
  async observeSince() {
    return '';
  },
  legacyBroadcast(_draft: Draft) {
    return [{ type: 'plate-updated' }];
  },
};

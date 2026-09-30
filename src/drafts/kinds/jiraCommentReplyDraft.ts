import { Task, getTaskById, dismissTask } from '../../storage/taskRepository';
import { Draft } from '../../storage/draftRepository';
import { DraftHandler } from '../types';
import { updateJiraIssue } from '../../integrations/jiraMcp';
import { generateReplyDraft, ReplyDraftContent } from './replyDraftShared';

const COMMENT_REF_PATTERN = /^(.+):comment:\d+$/;

/**
 * Jira comment-reply drafts — same shape as teamsReplyDraft.ts/
 * emailReplyDraft.ts, built on generateReplyDraft's shared tool-gathering +
 * Gemini drafting. loadSubject is stricter than loadReplyTaskSubject's
 * plain source check: a `source: 'jira'` task can be either a plain issue
 * (externalRef = bare issue key, from getMyOpenJiraIssues) or a comment
 * mention (externalRef = "<issueKey>:comment:<commentId>", from
 * getJiraCommentMentions) — only the latter is a valid subject for this
 * draft kind.
 */
export const jiraCommentReplyDraft: DraftHandler<Task> = {
  kind: 'jira_comment_reply',
  subjectKind: 'task',
  gates: [{ key: 'submit', label: 'Post comment' }],
  redoStrategy: 'follow_up',
  loadSubject(subjectId) {
    const task = getTaskById(Number(subjectId));
    if (!task || task.source !== 'jira' || !COMMENT_REF_PATTERN.test(task.externalRef)) return undefined;
    return task;
  },
  generate: (input) =>
    generateReplyDraft(input, {
      logLabel: 'draftJiraCommentReply',
      channelLabel: 'Jira comment',
      toneHint: 'concise and professional',
    }),
  async execute(_gateKey, ctx) {
    const content = ctx.content as ReplyDraftContent;
    const match = ctx.subject.externalRef.match(COMMENT_REF_PATTERN);
    if (!match) throw new Error(`Malformed Jira comment task ref: ${ctx.subject.externalRef}`);
    const issueKey = match[1];
    await updateJiraIssue({ issueKey, comment: content.text });
    // Comment actually posted — this task is done, drop it from the queue
    // the same way an explicit Dismiss would.
    dismissTask(ctx.subject.id);
    return { text: content.text, at: new Date().toISOString(), channel: 'jira', issueKey };
  },
  async observeSince() {
    return '';
  },
  legacyBroadcast(_draft: Draft) {
    return [{ type: 'plate-updated' }];
  },
};

import { Task } from '../../storage/taskRepository';
import { Draft } from '../../storage/draftRepository';
import { DraftHandler } from '../types';
import { loadReplyTaskSubject, generateReplyDraft, ReplyDraftContent } from './replyDraftShared';

/**
 * Email-reply drafts — same shape as teamsReplyDraft.ts. Real automated
 * send was investigated against the
 * Microsoft 365 Claude connector (outlookMailSync.ts/microsoft365Calendar.ts
 * now use it for read/sync) but outlook_send_mail/outlook_send_draft/
 * outlook_create_reply_draft/outlook_delete_draft all reject with a
 * server-side "This tool is not available" permission_error under headless
 * CLI dispatch — only search and creating a brand-new standalone draft work.
 * Per the user's explicit choice, email stays manual: approving records the
 * final text and the client offers the existing mailto: deep link as the
 * send step, same as Teams.
 */
export const emailReplyDraft: DraftHandler<Task> = {
  kind: 'email_reply',
  subjectKind: 'task',
  gates: [{ key: 'send', label: 'Mark handled' }],
  redoStrategy: 'follow_up',
  loadSubject: loadReplyTaskSubject('email_message'),
  generate: (input) =>
    generateReplyDraft(input, {
      logLabel: 'draftEmailReply',
      channelLabel: 'email reply',
      toneHint: 'short and professional',
    }),
  async execute(_gateKey, ctx) {
    const content = ctx.content as ReplyDraftContent;
    return { text: content.text, at: new Date().toISOString(), manual: true, channel: 'email' };
  },
  async observeSince() {
    return '';
  },
  legacyBroadcast(_draft: Draft) {
    return [{ type: 'plate-updated' }];
  },
};

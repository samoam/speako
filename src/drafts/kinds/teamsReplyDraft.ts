import { Task } from '../../storage/taskRepository';
import { Draft } from '../../storage/draftRepository';
import { DraftHandler } from '../types';
import { loadReplyTaskSubject, generateReplyDraft, ReplyDraftContent } from './replyDraftShared';

/**
 * Teams-reply drafts, built on the generic draft gate. execute() does NOT
 * actually send anything — the
 * Microsoft 365 Claude connector (src/integrations/teamsConnectorSync.ts,
 * used for reads) has no Teams send capability either (write-gated,
 * unavailable), so this stays manual by necessity, not just by convention:
 * approving records the final text and timestamp, and the client copies it
 * for the user to paste into Teams themselves — but every step is still
 * drafted, refinable, and redoable like every other write in this app.
 */
export const teamsReplyDraft: DraftHandler<Task> = {
  kind: 'teams_reply',
  subjectKind: 'task',
  gates: [{ key: 'send', label: 'Mark handled' }],
  redoStrategy: 'follow_up',
  loadSubject: loadReplyTaskSubject('teams_message'),
  generate: (input) =>
    generateReplyDraft(input, {
      logLabel: 'draftTeamsReply',
      channelLabel: 'Teams chat message',
      toneHint: 'short and casual, the way a real Teams message reads',
    }),
  async execute(_gateKey, ctx) {
    const content = ctx.content as ReplyDraftContent;
    return { text: content.text, at: new Date().toISOString(), manual: true, channel: 'teams' };
  },
  async observeSince() {
    // No real send (see the header comment) — nothing to observe post-execution.
    return '';
  },
  legacyBroadcast(_draft: Draft) {
    // The pre-existing read-only draft textarea has no completion event of
    // its own — 'plate-updated' is what the Dashboard already listens for
    // to re-fetch and re-render task cards with the current draft state.
    return [{ type: 'plate-updated' }];
  },
};

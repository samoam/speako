import { DraftRevision } from '../storage/draftRepository';

/**
 * Renders a draft's current content + refinement conversation so far into a
 * prompt block, shared by every Gemini-backed kind handler's refine path
 * (see e.g. src/drafts/kinds/replyDraftShared.ts). `priorContent` is
 * rendered as-is if it's already a string (most text-reply kinds), or
 * pretty-printed JSON otherwise (structured kinds like Jira/Confluence).
 */
export function buildRefinementBlock(history: DraftRevision[], priorContent: unknown): string {
  const lines: string[] = [];
  const renderedContent = typeof priorContent === 'string' ? priorContent : JSON.stringify(priorContent, null, 2);
  lines.push(`Current draft:\n${renderedContent}`);

  if (history.length) {
    lines.push('\nConversation so far:');
    for (const rev of history) {
      if (rev.kind === 'instruction') lines.push(`User: ${rev.text}`);
      else if (rev.kind === 'draft') lines.push(`You: (revised) ${rev.text || 'Updated the draft.'}`);
      else if (rev.kind === 'answer') lines.push(`You: ${rev.text}`);
      else if (rev.kind === 'question') lines.push(`You asked: ${rev.text}`);
      else if (rev.kind === 'manual_edit') lines.push('User manually edited the draft.');
    }
  }

  return lines.join('\n');
}

/**
 * Forces the model to declare up front whether the user's latest instruction
 * asked for a CHANGE to the draft or asked a QUESTION about it — this is
 * what lets "why did you flag this as urgent?" answer without silently
 * clobbering the draft (see types.ts's DraftGenerateResult). `draftText`
 * only fits a plain-text reply draft (Teams/email); a structured kind
 * (Jira/Confluence fields) defines its own variant with the same
 * action/answer/note shape but a richer `draft` object in place of `draftText`.
 */
export const REFINE_ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['revise', 'answer'],
      description:
        '"revise" if the user\'s newest message asks for a change to the draft itself. "answer" if it\'s a question about the draft or the reasoning behind it, not a request to change it.',
    },
    answer: {
      type: 'string',
      nullable: true,
      description: 'Only when action is "answer": a direct answer to the user\'s question.',
    },
    note: {
      type: 'string',
      nullable: true,
      description: 'Only when action is "revise": one short sentence describing what changed, shown in the refinement history.',
    },
    draftText: {
      type: 'string',
      nullable: true,
      description: 'Only when action is "revise": the full revised draft text.',
    },
  },
  required: ['action'],
};

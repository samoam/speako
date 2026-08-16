import { config } from '../../config';
import { getGeminiClient } from '../../gemini/geminiClient';
import { logGeminiUsage } from '../../gemini/logUsage';
import { getActionItem, setActionItemExternalRef, ActionItem } from '../../storage/summaryRepository';
import { createJiraIssue, updateJiraIssue, extractIssueKeys } from '../../integrations/jiraMcp';
import { suggestJiraFields } from '../../summarization/actionItemDrafts';
import { buildRefinementBlock } from '../refinePrompt';
import { DraftHandler } from '../types';

/** Mirrors the fields the pre-existing Jira dialog (index.html's jiraDialogBodyHtml) collected — kept flat rather than a create/update union so refine can freely move between the two modes without re-shaping the object. */
export interface JiraActionDraftContent {
  mode: 'create' | 'update';
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  issueKey: string;
  transition: string;
  comment: string;
}

const JIRA_REFINE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['revise', 'answer'] },
    answer: { type: 'string', nullable: true, description: 'Only when action is "answer".' },
    note: { type: 'string', nullable: true, description: 'Only when action is "revise": one short sentence describing what changed.' },
    draft: {
      type: 'object',
      nullable: true,
      description: 'Only when action is "revise": the FULL revised draft — every field, not just the one that changed.',
      properties: {
        mode: { type: 'string', enum: ['create', 'update'] },
        projectKey: { type: 'string' },
        issueType: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        issueKey: { type: 'string' },
        transition: { type: 'string' },
        comment: { type: 'string' },
      },
    },
  },
  required: ['action'],
};

/**
 * Jira create/update drafts, migrated onto the generic gate from the
 * Action Items tab's dialog (POST /api/action-items/:id/jira). The route
 * itself now delegates its write logic to execute() below (see server.ts),
 * so both the legacy dialog and this kind share one implementation while
 * the old UI is still around.
 */
export const jiraActionDraft: DraftHandler<ActionItem> = {
  kind: 'jira_action',
  subjectKind: 'action_item',
  gates: [{ key: 'submit', label: 'Submit' }],
  redoStrategy: 'follow_up',
  loadSubject: (subjectId) => getActionItem(Number(subjectId)),
  async generate(input) {
    const item = input.subject;

    if (input.redo) {
      // Full lifecycle-aware transitions (re-checking the ticket's live
      // status) are the Jira lifecycle engine's job (src/dev/lifecycle.ts,
      // jiraTransitionDraft.ts) — this is a lighter-weight version: same
      // key/mode, a fresh follow-up comment.
      const priorContent = input.redo.priorContent as JiraActionDraftContent;
      return { mode: 'draft', content: { ...priorContent, comment: input.redo.instruction || 'Follow-up note.' } };
    }

    if (input.instruction) {
      if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
      const priorContent = input.priorContent as JiraActionDraftContent;
      const refinementBlock = buildRefinementBlock(input.history, priorContent);
      const prompt = `You are helping refine a drafted Jira issue create/update through a chat-style conversation.

${refinementBlock}

The user's newest instruction: ${JSON.stringify(input.instruction)}

If they're asking for a CHANGE, return the full revised draft object (every field, not just the one that changed) under "draft" — keep "mode" as-is unless they explicitly ask to switch between creating a new issue and updating an existing one. If they're asking a QUESTION about the draft or your reasoning, answer it directly and leave the draft alone.`;
      const response = await getGeminiClient().models.generateContent({
        model: config.geminiFastModel,
        contents: prompt,
        config: { responseMimeType: 'application/json', responseSchema: JIRA_REFINE_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
      });
      logGeminiUsage('refineJiraActionDraft', response);
      const parsed = JSON.parse(response.text ?? '{}');
      if (parsed.action === 'answer') {
        return { mode: 'answer', text: parsed.answer || "I don't have anything more specific to add." };
      }
      return { mode: 'draft', content: { ...priorContent, ...parsed.draft }, note: parsed.note };
    }

    // First generation — same "never decide create-vs-update mode itself" rule the old dialog followed:
    // a deterministic issue-key regex on the description drives it, the AI only suggests fields within that mode.
    const detectedKey = extractIssueKeys(item.description)[0] || '';
    const mode: 'create' | 'update' = detectedKey ? 'update' : 'create';
    const suggestion = await suggestJiraFields(item);
    const content: JiraActionDraftContent = {
      mode,
      projectKey: '',
      issueType: suggestion.issueType,
      summary: suggestion.summary,
      description: suggestion.description,
      issueKey: detectedKey,
      transition: suggestion.transition || '',
      comment: suggestion.comment,
    };
    return { mode: 'draft', content };
  },
  async execute(_gateKey, ctx) {
    const content = ctx.content as JiraActionDraftContent;
    const item = ctx.subject;
    let result: { key: string; url: string };
    let action: 'created' | 'updated';
    if (content.mode === 'update') {
      if (!content.issueKey) throw new Error('Issue key is required.');
      if (!content.transition && !content.comment) throw new Error('Provide a status transition and/or a comment.');
      result = await updateJiraIssue({ issueKey: content.issueKey, transition: content.transition || undefined, comment: content.comment || undefined });
      action = 'updated';
    } else {
      if (!content.projectKey || !content.issueType) throw new Error('Project key and issue type are required.');
      result = await createJiraIssue({ projectKey: content.projectKey, issueType: content.issueType, summary: content.summary || item.description, description: content.description || undefined });
      action = 'created';
    }
    setActionItemExternalRef(item.id, { tool: 'jira', action, key: result.key, url: result.url, at: new Date().toISOString() });
    return { key: result.key, url: result.url, action };
  },
  legacyBroadcast(draft) {
    // The Action Items tab's row rendering still listens for this event
    // (index.html) — fired here too so it keeps working during migration.
    const item = getActionItem(Number(draft.subjectId));
    if (!item) return;
    return [{ type: 'action-item-updated', sessionId: item.sessionId, actionItem: item }];
  },
};

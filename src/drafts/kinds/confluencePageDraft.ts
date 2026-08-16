import { getActionItem, setActionItemExternalRef, ActionItem } from '../../storage/summaryRepository';
import { suggestConfluenceFields } from '../../summarization/actionItemDrafts';
import { DraftHandler } from '../types';
import { generateConfluencePageDraft, executeConfluencePageDraft, ConfluencePageDraftContent } from './confluenceDraftShared';

export { ConfluencePageDraftContent };

/**
 * Confluence create/update drafts, migrated onto the generic gate from the
 * Action Items tab's dialog (POST /api/action-items/:id/confluence) — same
 * migration shape as jiraActionDraft.ts. Generate/refine/redo/execute logic
 * lives in confluenceDraftShared.ts, shared with confluenceDevCycleDraft.ts.
 */
export const confluencePageDraft: DraftHandler<ActionItem> = {
  kind: 'confluence_page',
  subjectKind: 'action_item',
  gates: [{ key: 'submit', label: 'Submit' }],
  redoStrategy: 'amend',
  loadSubject: (subjectId) => getActionItem(Number(subjectId)),
  generate(input) {
    return generateConfluencePageDraft(input, { logLabel: 'refineConfluencePageDraft', sourceLabel: 'a meeting action item' }, async (item) => {
      const suggestion = await suggestConfluenceFields(item);
      return { title: suggestion.title, content: suggestion.content };
    });
  },
  async execute(_gateKey, ctx) {
    const item = ctx.subject;
    const { pageId, url, action } = await executeConfluencePageDraft(ctx, { title: item.description.slice(0, 200), content: item.description });
    setActionItemExternalRef(item.id, { tool: 'confluence', action, key: pageId, url, at: new Date().toISOString() });
    return { pageId, url, action };
  },
  legacyBroadcast(draft) {
    const item = getActionItem(Number(draft.subjectId));
    if (!item) return;
    return [{ type: 'action-item-updated', sessionId: item.sessionId, actionItem: item }];
  },
};

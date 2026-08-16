import { config } from '../../config';
import { getGeminiClient } from '../../gemini/geminiClient';
import { logGeminiUsage } from '../../gemini/logUsage';
import { createConfluencePage, updateConfluencePage } from '../../integrations/confluenceMcp';
import { Draft } from '../../storage/draftRepository';
import { buildRefinementBlock } from '../refinePrompt';
import { DraftGenerateInput, DraftGenerateResult } from '../types';

/** Mirrors the fields the pre-existing Confluence dialog (index.html's confluenceDialogBodyHtml) collected. Shared by every Confluence-drafting kind — confluence_page (action-item-seeded) and confluence_dev_cycle_update (dev-cycle-seeded). */
export interface ConfluencePageDraftContent {
  mode: 'create' | 'update';
  spaceKey: string;
  parentId: string;
  pageId: string;
  title: string;
  content: string;
}

const CONFLUENCE_REFINE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['revise', 'answer'] },
    answer: { type: 'string', nullable: true },
    note: { type: 'string', nullable: true, description: 'Only when action is "revise": one short sentence describing what changed.' },
    draft: {
      type: 'object',
      nullable: true,
      description: 'Only when action is "revise": the FULL revised draft — every field, not just the one that changed.',
      properties: {
        mode: { type: 'string', enum: ['create', 'update'] },
        spaceKey: { type: 'string' },
        parentId: { type: 'string' },
        pageId: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  required: ['action'],
};

export interface ConfluenceDraftSeed {
  title: string;
  content: string;
}

export interface ConfluenceDraftPromptOptions {
  logLabel: string;
  /** e.g. "a meeting action item" / "a completed dev cycle" — used in the refine prompt's framing. */
  sourceLabel: string;
}

/**
 * Shared generate() body for confluence_page/confluence_dev_cycle_update —
 * first generation seeds from whatever `seed()` produces (a one-off Gemini
 * call per kind, since the source text differs), refine turns share the same
 * answer/revise envelope, and redo turns re-update the same page (execute()
 * reads pageId back out of the draft's executionRef/resultRef).
 */
export async function generateConfluencePageDraft<TSubject>(
  input: DraftGenerateInput<TSubject>,
  opts: ConfluenceDraftPromptOptions,
  seed: (subject: TSubject) => Promise<ConfluenceDraftSeed>
): Promise<DraftGenerateResult> {
  if (input.redo) {
    // 'amend' strategy — a Confluence redo re-updates the SAME page rather
    // than creating a second one; execute() reads pageId back out of
    // priorResultRef/executionRef, so the draft content here just needs the new body.
    const priorContent = input.redo.priorContent as ConfluencePageDraftContent;
    return {
      mode: 'draft',
      content: { ...priorContent, mode: 'update', content: input.redo.instruction ? `${priorContent.content}\n\n${input.redo.instruction}` : priorContent.content },
    };
  }

  if (input.instruction) {
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
    const priorContent = input.priorContent as ConfluencePageDraftContent;
    const refinementBlock = buildRefinementBlock(input.history, priorContent);
    const prompt = `You are helping refine a drafted Confluence page create/update (seeded from ${opts.sourceLabel}) through a chat-style conversation.

${refinementBlock}

The user's newest instruction: ${JSON.stringify(input.instruction)}

If they're asking for a CHANGE, return the full revised draft object (every field, not just the one that changed) under "draft" — keep "mode" as-is unless they explicitly ask to switch between creating a new page and updating an existing one. If they're asking a QUESTION about the draft or your reasoning, answer it directly and leave the draft alone.`;
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiFastModel,
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema: CONFLUENCE_REFINE_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
    });
    logGeminiUsage(opts.logLabel, response);
    const parsed = JSON.parse(response.text ?? '{}');
    if (parsed.action === 'answer') {
      return { mode: 'answer', text: parsed.answer || "I don't have anything more specific to add." };
    }
    return { mode: 'draft', content: { ...priorContent, ...parsed.draft }, note: parsed.note };
  }

  // First generation — always defaults to 'create' mode, same as the old dialog
  // (Confluence pages have no deterministic "this is an existing page" signal
  // in free text the way a Jira issue key does).
  const suggestion = await seed(input.subject);
  const content: ConfluencePageDraftContent = {
    mode: 'create',
    spaceKey: '',
    parentId: '',
    pageId: '',
    title: suggestion.title,
    content: suggestion.content,
  };
  return { mode: 'draft', content };
}

/** Shared execute() body — actually creates/updates the Confluence page. Callers append their own subject-specific bookkeeping (e.g. confluencePageDraft.ts's setActionItemExternalRef) around this. */
export async function executeConfluencePageDraft(
  ctx: { draft: Draft; content: unknown },
  fallback: ConfluenceDraftSeed
): Promise<{ pageId: string; url: string; action: 'created' | 'updated' }> {
  const content = ctx.content as ConfluencePageDraftContent;
  const title = content.title?.trim() || fallback.title;
  const body = content.content?.trim() || fallback.content;
  if (content.mode === 'update') {
    const pageId = content.pageId?.trim() || (ctx.draft.executionRef as any)?.pageId || (ctx.draft.resultRef as any)?.pageId;
    if (!pageId) throw new Error('Page ID is required.');
    const result = await updateConfluencePage({ pageId, title, content: body });
    return { pageId: result.id, url: result.url, action: 'updated' };
  }
  if (!content.spaceKey) throw new Error('Space key is required.');
  const result = await createConfluencePage({ spaceKey: content.spaceKey, title, content: body, parentId: content.parentId?.trim() || undefined });
  return { pageId: result.id, url: result.url, action: 'created' };
}

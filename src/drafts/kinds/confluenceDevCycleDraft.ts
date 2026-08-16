import { config } from '../../config';
import { getGeminiClient } from '../../gemini/geminiClient';
import { logGeminiUsage } from '../../gemini/logUsage';
import { DevCycle, getDevCycle } from '../../storage/devCycleRepository';
import { getLatestDraftForSubject } from '../../storage/draftRepository';
import { getJiraIssueDetail } from '../../integrations/jiraMcp';
import { StructuredDevPlan } from '../../dev/devPlan';
import { DraftHandler } from '../types';
import { generateConfluencePageDraft, executeConfluencePageDraft, ConfluenceDraftSeed } from './confluenceDraftShared';

const SEED_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A concise Confluence page title (under 100 characters).' },
    content: { type: 'string', description: "The page body in Markdown — what changed, why, and anything a teammate would need to know (behavior, architecture, or runbook impact). Ground it in the ticket and plan given, don't invent facts they don't imply." },
  },
  required: ['title', 'content'],
};

async function suggestDevCycleConfluenceFields(cycle: DevCycle): Promise<ConfluenceDraftSeed> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

  const ticket = await getJiraIssueDetail(cycle.ticketKey);
  const planDraft = getLatestDraftForSubject('dev_cycle', cycle.id, 'dev_plan');
  const plan = (planDraft?.content ?? null) as StructuredDevPlan | null;

  const prompt = `You are helping document a completed development cycle as a Confluence page. Draft a title and a documentation-worthy body from the ticket and plan below — focus on what changed and why, and any behavior/architecture/runbook impact a teammate would need to know.

Ticket: ${cycle.ticketKey}${ticket ? ` — ${ticket.summary}` : ''}
${ticket?.description ? `Description:\n${ticket.description}` : ''}
${plan ? `Plan understanding:\n${plan.understanding}\n\nApproach:\n${plan.approach}` : ''}
${plan?.risks?.length ? `Risks:\n${plan.risks.map((r) => `- ${r.risk} (${r.severity}): ${r.mitigation}`).join('\n')}` : ''}`;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiFastModel,
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: SEED_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
  });
  logGeminiUsage('suggestDevCycleConfluenceFields', response);
  const parsed = JSON.parse(response.text ?? '{}');
  return {
    title: parsed.title || `${cycle.ticketKey}: documentation update`,
    content: parsed.content || plan?.understanding || '',
  };
}

/**
 * Confluence documentation drafted from a dev cycle (blueprint §5.1 step 6 /
 * §6 item 2) — auto-triggered as a side effect of prOpenDraft.ts's generate()
 * when the self-review agent judges the change confluenceRelevant (see
 * prePrChecks.ts), and also reachable on-demand via the "Document…" button
 * (blueprint §6 item 3) through the same get-or-create draft-panel flow.
 * Generate/refine/redo/execute logic lives in confluenceDraftShared.ts,
 * shared with confluencePageDraft.ts.
 */
export const confluenceDevCycleDraft: DraftHandler<DevCycle> = {
  kind: 'confluence_dev_cycle_update',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'submit', label: 'Submit' }],
  redoStrategy: 'amend',
  loadSubject: (subjectId) => getDevCycle(Number(subjectId)),
  generate(input) {
    return generateConfluencePageDraft(input, { logLabel: 'refineConfluenceDevCycleDraft', sourceLabel: 'a completed dev cycle' }, suggestDevCycleConfluenceFields);
  },
  async execute(_gateKey, ctx) {
    const cycle = ctx.subject;
    return executeConfluencePageDraft(ctx, { title: `${cycle.ticketKey}: documentation update`, content: '' });
  },
  legacyBroadcast(draft) {
    return [{ type: 'dev-cycle-updated', devCycleId: Number(draft.subjectId) }];
  },
};

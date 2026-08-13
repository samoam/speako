import { config } from '../config';
import { TranscriptSegment } from '../types';
import { toPlainText } from '../transcriptFormat';
import { NewActionItem, ActionItemType, ACTION_ITEM_TYPES } from '../storage/summaryRepository';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { createSharedCache } from '../gemini/contextCache';

const SUMMARY_SYSTEM_PROMPT = `You are an expert meeting assistant. You will be given a speaker-labeled
transcript of a recorded conversation or meeting. Produce a concise but comprehensive summary.
Ignore small talk, filler, and off-topic remarks. Write each field in markdown (headers not needed
within a field, but use bullet points/bold where it helps readability). If a field genuinely has
nothing to report (e.g. no decisions were made), say so briefly rather than inventing content.`;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string', description: 'Meeting purpose, participants (by speaker label), and overall outcome.' },
    keyDecisions: { type: 'string', description: 'Decisions actually made during the conversation.' },
    discussionTopics: { type: 'string', description: 'Main topics discussed, grouped by theme.' },
    nextSteps: { type: 'string', description: 'What happens next, at a high level (detailed commitments go in action items separately).' },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short 2-4 word topic tags capturing the main themes discussed, for cross-meeting topic tracking. 2-6 tags, no duplicates.',
    },
  },
  required: ['overview', 'keyDecisions', 'discussionTopics', 'nextSteps', 'topics'],
};

const ACTION_ITEMS_SYSTEM_PROMPT = `You are an expert meeting assistant extracting action items from a
speaker-labeled transcript. Only extract genuine commitments or clearly assigned tasks — exclude vague
statements, hypotheticals, and things that were merely discussed but not committed to. For each item:
- "owner" is the speaker label responsible, or null if truly unclear who owns it.
- "dueDate" is whatever was stated (a date, "next week", etc.), or null if none was given.
- "confidence" is "explicit" if directly stated as a commitment (e.g. "I'll send the report by Friday"),
  or "inferred" if implied by the discussion but not directly committed to.
- "type" classifies what kind of follow-up this is, so the app can offer the right one-click action:
  "code_change" for a code/bug/repo change, "email" for something that should be sent as an email,
  "jira" for a task that belongs in a Jira ticket, "confluence" for documentation that should be
  written/updated on a Confluence page, "schedule_meeting" for something that needs its own follow-up
  meeting, "teams_message" for a quick note better sent via Teams chat than any of the above, "reminder"
  for a simple personal reminder with no external artifact, or "general" if none of these fit.
Return an empty array if there are no genuine action items — do not invent any.`;

// Object-wrapped, not a bare top-level array — a bare `type:'array'` responseSchema
// was confirmed to trigger a real 400 INVALID_ARGUMENT from the live Gemini API
// (found via e2e testing, not caught by mocked unit tests), so every schema in
// this app wraps its list in a named object property instead.
const ACTION_ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          owner: { type: 'string', nullable: true },
          description: { type: 'string' },
          dueDate: { type: 'string', nullable: true },
          confidence: { type: 'string', enum: ['explicit', 'inferred'] },
          type: {
            type: 'string',
            enum: ['general', 'code_change', 'email', 'jira', 'confluence', 'reminder', 'todo', 'schedule_meeting', 'teams_message'],
          },
        },
        required: ['description', 'confidence', 'type'],
      },
    },
  },
  required: ['actionItems'],
};

export interface GeneratedSummary {
  overview: string;
  keyDecisions: string;
  discussionTopics: string;
  nextSteps: string;
  topics: string[];
  modelUsed: string;
}

/** transcriptOrCache: pass a cachedContent resource name (from createSharedCache) to avoid resending the transcript, or the raw transcript string to send it inline. */
async function summarizeSessionFrom(transcriptOrCache: { transcript: string } | { cachedContent: string }): Promise<GeneratedSummary> {
  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: 'cachedContent' in transcriptOrCache ? SUMMARY_SYSTEM_PROMPT : `${SUMMARY_SYSTEM_PROMPT}\n\nTranscript:\n${transcriptOrCache.transcript}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: SUMMARY_SCHEMA,
      // thinkingBudget: 0 is currently rejected (400) by gemini-flash-latest — 1 is the smallest accepted budget.
      thinkingConfig: { thinkingBudget: 1 },
      ...('cachedContent' in transcriptOrCache ? { cachedContent: transcriptOrCache.cachedContent } : {}),
    },
  });
  logGeminiUsage('summarizeSession', response);
  const parsed = JSON.parse(response.text ?? '{}');
  return { ...parsed, topics: parsed.topics ?? [], modelUsed: config.geminiModel };
}

async function extractActionItemsFrom(transcriptOrCache: { transcript: string } | { cachedContent: string }): Promise<NewActionItem[]> {
  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: 'cachedContent' in transcriptOrCache ? ACTION_ITEMS_SYSTEM_PROMPT : `${ACTION_ITEMS_SYSTEM_PROMPT}\n\nTranscript:\n${transcriptOrCache.transcript}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: ACTION_ITEMS_SCHEMA,
      // thinkingBudget: 0 is currently rejected (400) by gemini-flash-latest — 1 is the smallest accepted budget.
      thinkingConfig: { thinkingBudget: 1 },
      ...('cachedContent' in transcriptOrCache ? { cachedContent: transcriptOrCache.cachedContent } : {}),
    },
  });
  logGeminiUsage('extractActionItems', response);
  const parsed = JSON.parse(response.text ?? '{}');
  const items = (parsed.actionItems ?? []) as NewActionItem[];
  // Defensive even though the schema enum should already guarantee this —
  // never trust a model response as blindly as a schema-validated one.
  return items.map((item) => ({
    ...item,
    type: ACTION_ITEM_TYPES.includes(item.type as ActionItemType) ? item.type : 'general',
  }));
}

export async function summarizeSession(segments: TranscriptSegment[]): Promise<GeneratedSummary> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
  }
  return summarizeSessionFrom({ transcript: toPlainText(segments) });
}

export async function extractActionItems(segments: TranscriptSegment[]): Promise<NewActionItem[]> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
  }
  return extractActionItemsFrom({ transcript: toPlainText(segments) });
}

/**
 * Runs summarizeSession + extractActionItems together, sharing one explicit
 * Gemini cache for the (potentially large) transcript both calls would
 * otherwise send in full — cached reads bill at ~10% of normal input price.
 * Falls back to sending the transcript inline to both (today's behavior) if
 * the transcript's too short to be worth caching or cache creation fails for
 * any reason. Preferred over calling summarizeSession/extractActionItems
 * separately when both are needed, which is every real call site today.
 */
export async function summarizeAndExtractActionItems(segments: TranscriptSegment[]): Promise<[GeneratedSummary, NewActionItem[]]> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
  }
  const transcript = toPlainText(segments);
  const cachedContent = await createSharedCache(config.geminiModel, transcript);
  const source = cachedContent ? { cachedContent } : { transcript };
  return Promise.all([summarizeSessionFrom(source), extractActionItemsFrom(source)]);
}

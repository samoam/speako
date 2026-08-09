import { config } from '../config';
import { TranscriptSegment } from '../types';
import { toPlainText } from '../transcriptFormat';
import { NewActionItem } from '../storage/summaryRepository';
import { getGeminiClient } from '../gemini/geminiClient';

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
  },
  required: ['overview', 'keyDecisions', 'discussionTopics', 'nextSteps'],
};

const ACTION_ITEMS_SYSTEM_PROMPT = `You are an expert meeting assistant extracting action items from a
speaker-labeled transcript. Only extract genuine commitments or clearly assigned tasks — exclude vague
statements, hypotheticals, and things that were merely discussed but not committed to. For each item:
- "owner" is the speaker label responsible, or null if truly unclear who owns it.
- "dueDate" is whatever was stated (a date, "next week", etc.), or null if none was given.
- "confidence" is "explicit" if directly stated as a commitment (e.g. "I'll send the report by Friday"),
  or "inferred" if implied by the discussion but not directly committed to.
Return an empty array if there are no genuine action items — do not invent any.`;

const ACTION_ITEMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      owner: { type: 'string', nullable: true },
      description: { type: 'string' },
      dueDate: { type: 'string', nullable: true },
      confidence: { type: 'string', enum: ['explicit', 'inferred'] },
    },
    required: ['description', 'confidence'],
  },
};

export interface GeneratedSummary {
  overview: string;
  keyDecisions: string;
  discussionTopics: string;
  nextSteps: string;
  modelUsed: string;
}

/** Two separate calls (summary, action items) rather than one combined prompt — improves precision on each. */
export async function summarizeSession(segments: TranscriptSegment[]): Promise<GeneratedSummary> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
  }
  const transcript = toPlainText(segments);

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: `${SUMMARY_SYSTEM_PROMPT}\n\nTranscript:\n${transcript}`,
    config: { responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA },
  });

  const parsed = JSON.parse(response.text ?? '{}');
  return { ...parsed, modelUsed: config.geminiModel };
}

export async function extractActionItems(segments: TranscriptSegment[]): Promise<NewActionItem[]> {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
  }
  const transcript = toPlainText(segments);

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: `${ACTION_ITEMS_SYSTEM_PROMPT}\n\nTranscript:\n${transcript}`,
    config: { responseMimeType: 'application/json', responseSchema: ACTION_ITEMS_SCHEMA },
  });

  const parsed = JSON.parse(response.text ?? '[]');
  return parsed as NewActionItem[];
}

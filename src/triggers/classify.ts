import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';

const CLASSIFY_PROMPT = `You are a fast filter watching a live meeting transcript for moments worth
flagging. You'll be given the most recent one or two spoken lines (a small window, not the whole
meeting) — classify ONLY this window, not what a full conversation might imply.

Categories:
- factualClaim: a specific, checkable number, date, name, or technical statement (not opinion or small talk).
- decisionPoint: language indicating a decision is actively being made right now ("let's go with...", "we'll decide...").
- vagueness: a commitment or requirement stated WITHOUT a clear owner, deadline, or specifics (e.g. "someone should look into that at some point").

For each category, give present (true only if it clearly applies to THIS window), confidence (0-1,
how sure you are), and a one-sentence reason. Default to present:false when in doubt — silence is
better than a false alarm here.`;

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    factualClaim: {
      type: 'object',
      properties: { present: { type: 'boolean' }, confidence: { type: 'number' }, reason: { type: 'string' } },
      required: ['present', 'confidence', 'reason'],
    },
    decisionPoint: {
      type: 'object',
      properties: { present: { type: 'boolean' }, confidence: { type: 'number' }, reason: { type: 'string' } },
      required: ['present', 'confidence', 'reason'],
    },
    vagueness: {
      type: 'object',
      properties: { present: { type: 'boolean' }, confidence: { type: 'number' }, reason: { type: 'string' } },
      required: ['present', 'confidence', 'reason'],
    },
  },
  required: ['factualClaim', 'decisionPoint', 'vagueness'],
};

export interface CategoryResult {
  present: boolean;
  confidence: number;
  reason: string;
}

export interface ClassificationResult {
  factualClaim: CategoryResult;
  decisionPoint: CategoryResult;
  vagueness: CategoryResult;
}

/**
 * Stage 1 fast filter (spec §4.2) — one cheap Gemini call per finalized
 * segment/window. `meetingContext`, when present (the session's current
 * meeting_state.rolling_summary — which pre-meeting prep seeds before any
 * transcript exists, per PrepService), is prepended so classification isn't
 * purely reactive to the last line or two — a claim that contradicts a
 * prepped Jira ticket status, for instance, is easier to flag with that
 * context in view than without it.
 */
export async function classifySegment(text: string, meetingContext?: string): Promise<ClassificationResult> {
  const contextBlock = meetingContext ? `Meeting context so far:\n${meetingContext}\n\n` : '';
  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: `${CLASSIFY_PROMPT}\n\n${contextBlock}Window:\n${text}`,
    config: { responseMimeType: 'application/json', responseSchema: CLASSIFY_SCHEMA },
  });
  return JSON.parse(response.text ?? '{}');
}

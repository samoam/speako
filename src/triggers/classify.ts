import { config } from '../config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleGenAI } = require('@google/genai');

let client: any = null;
function getClient(): any {
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

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

/** Stage 1 fast filter (spec §4.2) — one cheap Gemini call per finalized segment/window. */
export async function classifySegment(text: string): Promise<ClassificationResult> {
  const response = await getClient().models.generateContent({
    model: config.geminiModel,
    contents: `${CLASSIFY_PROMPT}\n\nWindow:\n${text}`,
    config: { responseMimeType: 'application/json', responseSchema: CLASSIFY_SCHEMA },
  });
  return JSON.parse(response.text ?? '{}');
}

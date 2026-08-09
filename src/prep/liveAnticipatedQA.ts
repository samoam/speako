import { config } from '../config';
import { embedText, cosineSimilarity } from '../rag/rag';
import { getGeminiClient } from '../gemini/geminiClient';
import { LikelyQuestion, QuestionToAsk } from './anticipateQA';

export interface EmbeddedLikelyQuestion {
  question: LikelyQuestion;
  embedding: number[];
}

/**
 * Deliberately stricter than config.ragSimilarityThreshold (0.65) — that
 * threshold asks "is this loosely related", this asks "did someone just ask
 * this exact prepared question". Hardcoded rather than a settings field,
 * same as retro.ts's FRICTION_SCORE_THRESHOLD — an internal tuning constant,
 * not something a user needs to tweak.
 */
const LIKELY_QUESTION_MATCH_THRESHOLD = 0.82;

export async function embedLikelyQuestions(questions: LikelyQuestion[]): Promise<EmbeddedLikelyQuestion[]> {
  const embedded: EmbeddedLikelyQuestion[] = [];
  for (const question of questions) {
    try {
      embedded.push({ question, embedding: await embedText(question.question) });
    } catch (err: any) {
      console.error('[prep] failed to embed anticipated question:', err.message);
    }
  }
  return embedded;
}

/**
 * Embeds the live segment once and compares against every prepared
 * question's precomputed embedding — no Gemini generation call needed here,
 * the answer is already drafted; this only decides whether it applies.
 */
export async function matchLikelyQuestion(
  segmentText: string,
  embedded: EmbeddedLikelyQuestion[]
): Promise<{ item: EmbeddedLikelyQuestion; score: number } | null> {
  if (embedded.length === 0) return null;

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(segmentText);
  } catch (err: any) {
    console.error('[prep] failed to embed live segment for anticipated-question match:', err.message);
    return null;
  }

  let best: { item: EmbeddedLikelyQuestion; score: number } | null = null;
  for (const item of embedded) {
    const score = cosineSimilarity(queryEmbedding, item.embedding);
    if (score >= LIKELY_QUESTION_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { item, score };
    }
  }
  return best;
}

const ASK_NOW_PROMPT = `You are monitoring a live meeting. The user prepared a list of questions before the meeting that they might want to ask. Given the meeting summary so far, return the EXACT text of any candidate questions that are now clearly relevant to ask, based on what's just been discussed — e.g. the topic they relate to just came up. Be conservative: only return a question if the moment is clearly right, not just loosely related. If none fit, return an empty list. Only return exact text matches from the candidate list — never rephrase or invent one.`;

const ASK_NOW_SCHEMA = {
  type: 'object',
  properties: {
    relevantQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['relevantQuestions'],
};

/**
 * Runs on the same cadence as updateMeetingState (see session.ts) rather than
 * per-segment — no extra per-segment cost, and "is this a good moment to ask
 * X" only makes sense evaluated against a settled summary, not one raw line.
 * Never throws; returns [] on failure so a hiccup here can't affect the rest
 * of the live pipeline.
 */
export async function checkQuestionsToAskRelevance(rollingSummary: string, remaining: QuestionToAsk[]): Promise<QuestionToAsk[]> {
  if (remaining.length === 0 || !config.geminiApiKey) return [];

  try {
    const prompt = `${ASK_NOW_PROMPT}\n\nMeeting so far:\n${rollingSummary || '(nothing yet)'}\n\nCandidate questions:\n${JSON.stringify(remaining.map((q) => q.question))}`;
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema: ASK_NOW_SCHEMA },
    });
    const parsed = JSON.parse(response.text ?? '{}');
    const relevantTexts: string[] = parsed.relevantQuestions ?? [];
    return remaining.filter((q) => relevantTexts.includes(q.question));
  } catch (err: any) {
    console.error('[prep] questions-to-ask relevance check failed:', err.message);
    return [];
  }
}

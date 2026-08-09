import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';

const WEB_FACT_CHECK_PROMPT = `You are fact-checking a spoken claim using web search. Judge whether it is correct.
- "match": search results clearly confirm the claim.
- "conflict": search results clearly contradict the claim.
- "insufficient": search didn't turn up enough to judge either way.
Be conservative — only answer match/conflict when results clearly support it; default to insufficient.
"groundTruth" should be the specific fact from search results that supports your answer, or null if insufficient.`;

const WEB_FACT_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['match', 'conflict', 'insufficient'] },
    groundTruth: { type: 'string', nullable: true },
  },
  required: ['result'],
};

export interface WebFactCheckOutcome {
  result: 'match' | 'conflict' | 'insufficient';
  groundTruth: string | null;
  citations: string[];
}

export function isWebFactCheckConfigured(): boolean {
  return !!config.geminiApiKey;
}

/**
 * Fallback fact-check for claims that Bitbucket/Jira/Confluence have nothing
 * on (e.g. general knowledge, not this team's tickets/code/docs) — uses
 * Gemini's built-in Google Search grounding (`tools: [{ googleSearch: {} }]`)
 * rather than a separate search API/key. Confirmed empirically: this combines
 * fine with structured JSON output (responseSchema) in the same call, so
 * search + verdict happen in one round trip rather than search-then-judge.
 */
export async function webFactCheckClaim(claimText: string): Promise<WebFactCheckOutcome | null> {
  if (!isWebFactCheckConfigured()) return null;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: `${WEB_FACT_CHECK_PROMPT}\n\nCLAIM: "${claimText}"`,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: 'application/json',
      responseSchema: WEB_FACT_CHECK_SCHEMA,
    },
  });

  const parsed = JSON.parse(response.text ?? '{}');
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const citations: string[] = [...new Set(chunks.map((c: any) => c.web?.title).filter(Boolean))] as string[];

  return {
    result: parsed.result ?? 'insufficient',
    groundTruth: parsed.groundTruth ?? null,
    citations,
  };
}

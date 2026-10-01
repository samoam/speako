import { generateJson, hasTextProvider } from '../ai/aiRouter';

const WEB_FACT_CHECK_PROMPT = `You are fact-checking a spoken claim using web search. Judge whether it is correct.
- "match": search results clearly confirm the claim.
- "conflict": search results clearly contradict the claim.
- "insufficient": search didn't turn up enough to judge either way.
Be conservative — only answer match/conflict when results clearly support it; default to insufficient.
"groundTruth" should be the specific fact from search results that supports your answer, or null if insufficient.
"sources" lists the titles of the web pages you relied on (empty if none).`;

const WEB_FACT_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['match', 'conflict', 'insufficient'] },
    groundTruth: { type: 'string', nullable: true },
    // Model-reported rather than read from Gemini's groundingMetadata, so the
    // Claude route (which has no grounding metadata) yields citations too.
    sources: { type: 'array', items: { type: 'string' }, description: 'Titles of the web pages the verdict is based on.' },
  },
  required: ['result', 'sources'],
};

export interface WebFactCheckOutcome {
  result: 'match' | 'conflict' | 'insufficient';
  groundTruth: string | null;
  citations: string[];
}

export function isWebFactCheckConfigured(): boolean {
  return hasTextProvider();
}

/**
 * Fallback fact-check for claims that Bitbucket/Jira/Confluence have nothing
 * on (e.g. general knowledge, not this team's tickets/code/docs). Search and
 * verdict happen in one call on both routes: Claude's WebSearch tool with
 * --json-schema (confirmed live, ~13s on haiku) or, as the metered failover,
 * Gemini's Google Search grounding with responseSchema (confirmed earlier to
 * combine fine). The verdict lands ~10s later than it did on Gemini alone —
 * accepted since this only runs after the internal sources came up empty.
 */
export async function webFactCheckClaim(claimText: string): Promise<WebFactCheckOutcome | null> {
  if (!isWebFactCheckConfigured()) return null;

  const parsed = await generateJson<any>('webResearch', 'webFactCheckClaim', `${WEB_FACT_CHECK_PROMPT}\n\nCLAIM: "${claimText}"`, WEB_FACT_CHECK_SCHEMA, {
    webSearch: true,
  });
  const sources: string[] = Array.isArray(parsed.sources) ? parsed.sources.filter((s: unknown) => typeof s === 'string' && s) : [];

  return {
    result: ['match', 'conflict', 'insufficient'].includes(parsed.result) ? parsed.result : 'insufficient',
    groundTruth: parsed.groundTruth ?? null,
    citations: [...new Set(sources)],
  };
}

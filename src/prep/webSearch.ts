import { generateText, hasTextProvider } from '../ai/aiRouter';

export function isPrepWebSearchConfigured(): boolean {
  return hasTextProvider();
}

/**
 * Open-ended web context for prep — no fixed match/conflict schema: this is
 * a last-resort source for external technology/standards not covered by
 * Jira/Confluence/Bitbucket, not a verdict. Claude's WebSearch tool first
 * (subscription), Gemini's Google Search grounding as the metered failover.
 */
export async function prepWebSearch(topic: string): Promise<string> {
  if (!isPrepWebSearchConfigured()) return '';
  return generateText(
    'webResearch',
    'prepWebSearch',
    `Using web search, give a brief (3-5 sentence) summary of relevant background on: "${topic}". Focus on facts someone would want to know walking into a technical discussion about this. Reply with the summary only.`,
    { webSearch: true }
  );
}

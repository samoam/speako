import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';

export function isPrepWebSearchConfigured(): boolean {
  return !!config.geminiApiKey;
}

/**
 * Open-ended web context for prep — same Gemini Google Search grounding
 * mechanism as webFactCheck.ts's claim verdicts, but no fixed match/conflict
 * schema: this is a last-resort source for external technology/standards not
 * covered by Jira/Confluence/Bitbucket, not a verdict.
 */
export async function prepWebSearch(topic: string): Promise<string> {
  if (!isPrepWebSearchConfigured()) return '';

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: `Using web search, give a brief (3-5 sentence) summary of relevant background on: "${topic}". Focus on facts someone would want to know walking into a technical discussion about this.`,
    config: { tools: [{ googleSearch: {} }] },
  });
  logGeminiUsage('prepWebSearch', response);

  return response.text ?? '';
}

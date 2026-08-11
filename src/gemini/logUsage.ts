import { recordGeminiUsage } from '../storage/geminiUsageRepository';

/**
 * Logs one Gemini call's real token usage (from `response.usageMetadata`)
 * and accumulates it into the gemini_usage table, tagged by feature — lets
 * the cost-optimization changes (model tiering, thinking-disable, caching)
 * be verified against real numbers instead of assumed. Fire-and-forget and
 * fail-soft: never throws, never blocks the caller's response path.
 */
export function logGeminiUsage(feature: string, response: any): void {
  try {
    const usage = response?.usageMetadata;
    if (!usage) return;
    const promptTokens = usage.promptTokenCount ?? 0;
    const outputTokens = usage.candidatesTokenCount ?? 0;
    const thinkingTokens = usage.thoughtsTokenCount ?? 0;
    console.log(
      `[gemini-usage] ${feature}: prompt=${promptTokens} output=${outputTokens} thinking=${thinkingTokens} total=${usage.totalTokenCount ?? promptTokens + outputTokens + thinkingTokens}`
    );
    recordGeminiUsage(feature, { promptTokens, outputTokens, thinkingTokens });
  } catch (err: any) {
    console.error('[gemini-usage] failed to record usage:', err.message);
  }
}

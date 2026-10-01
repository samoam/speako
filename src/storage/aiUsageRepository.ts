import { db } from './db';

export type AiUsageProvider = 'claude' | 'jev' | 'antigravity';

const upsertStmt = db.prepare(`
  INSERT INTO ai_usage (provider, feature, date, call_count, input_tokens, output_tokens)
  VALUES (@provider, @feature, @date, 1, @inputTokens, @outputTokens)
  ON CONFLICT(provider, feature, date) DO UPDATE SET
    call_count = call_count + 1,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens
`);

export interface AiUsageRow {
  provider: AiUsageProvider | 'gemini';
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Per-feature, per-provider totals since `sinceDate` (YYYY-MM-DD, inclusive),
 * merging ai_usage with gemini_usage (thinking tokens counted as output, as
 * Gemini bills them) — the Settings usage panel's one query.
 */
export function getAiUsageSince(sinceDate: string): AiUsageRow[] {
  return db
    .prepare(
      `SELECT provider, feature, SUM(call_count) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
       FROM ai_usage WHERE date >= @since GROUP BY provider, feature
       UNION ALL
       SELECT 'gemini' AS provider, feature, SUM(call_count), SUM(prompt_tokens), SUM(output_tokens) + SUM(thinking_tokens)
       FROM gemini_usage WHERE date >= @since GROUP BY feature
       ORDER BY feature, provider`
    )
    .all({ since: sinceDate }) as AiUsageRow[];
}

/** Never throws — usage tracking must not break the call it's measuring. */
export function recordAiUsage(provider: AiUsageProvider, feature: string, inputTokens: number, outputTokens: number): void {
  try {
    upsertStmt.run({ provider, feature, date: new Date().toISOString().slice(0, 10), inputTokens, outputTokens });
  } catch (err: any) {
    console.error('[ai-usage] failed to record usage:', err.message);
  }
}

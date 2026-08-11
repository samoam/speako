import { db } from './db';

export interface GeminiUsageTotals {
  feature: string;
  date: string;
  callCount: number;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

const upsertStmt = db.prepare(
  `INSERT INTO gemini_usage (feature, date, call_count, prompt_tokens, output_tokens, thinking_tokens)
   VALUES (@feature, @date, 1, @promptTokens, @outputTokens, @thinkingTokens)
   ON CONFLICT(feature, date) DO UPDATE SET
     call_count = call_count + 1,
     prompt_tokens = prompt_tokens + excluded.prompt_tokens,
     output_tokens = output_tokens + excluded.output_tokens,
     thinking_tokens = thinking_tokens + excluded.thinking_tokens`
);

/** Adds one call's token counts to today's running total for this feature. */
export function recordGeminiUsage(
  feature: string,
  usage: { promptTokens: number; outputTokens: number; thinkingTokens: number }
): void {
  upsertStmt.run({
    feature,
    date: new Date().toISOString().slice(0, 10),
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
  });
}

/** All-time totals per feature, most token-hungry first — used by a future settings/usage view. */
export function getGeminiUsageTotals(): GeminiUsageTotals[] {
  const rows = db
    .prepare(
      `SELECT feature, 'all-time' AS date, SUM(call_count) AS call_count,
              SUM(prompt_tokens) AS prompt_tokens, SUM(output_tokens) AS output_tokens, SUM(thinking_tokens) AS thinking_tokens
       FROM gemini_usage
       GROUP BY feature
       ORDER BY (SUM(prompt_tokens) + SUM(output_tokens)) DESC`
    )
    .all() as { feature: string; date: string; call_count: number; prompt_tokens: number; output_tokens: number; thinking_tokens: number }[];
  return rows.map((r) => ({
    feature: r.feature,
    date: r.date,
    callCount: r.call_count,
    promptTokens: r.prompt_tokens,
    outputTokens: r.output_tokens,
    thinkingTokens: r.thinking_tokens,
  }));
}

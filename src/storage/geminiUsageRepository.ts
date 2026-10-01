import { db } from './db';

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


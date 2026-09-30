import { db } from './db';

export type AiUsageProvider = 'claude' | 'jev';

const upsertStmt = db.prepare(`
  INSERT INTO ai_usage (provider, feature, date, call_count, input_tokens, output_tokens)
  VALUES (@provider, @feature, @date, 1, @inputTokens, @outputTokens)
  ON CONFLICT(provider, feature, date) DO UPDATE SET
    call_count = call_count + 1,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens
`);

/** Never throws — usage tracking must not break the call it's measuring. */
export function recordAiUsage(provider: AiUsageProvider, feature: string, inputTokens: number, outputTokens: number): void {
  try {
    upsertStmt.run({ provider, feature, date: new Date().toISOString().slice(0, 10), inputTokens, outputTokens });
  } catch (err: any) {
    console.error('[ai-usage] failed to record usage:', err.message);
  }
}

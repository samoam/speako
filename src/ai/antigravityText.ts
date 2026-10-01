import * as os from 'os';
import { runAgyTurn } from '../integrations/antigravityCli';

const TIMEOUT_MS = 3 * 60 * 1000;

export interface AntigravityTextResult {
  text: string;
  structured: any;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One read-only (`--mode plan`) agy turn used as the AI router's overflow
 * route — Google-subscription billed like the Claude route, so it's tried
 * before metered Gemini. Confirmed live (agy 1.2.14): `--json-schema` fills
 * `structured_output` (~4.5-7s end to end on gemini-3.8-flash-low). Runs
 * from os.tmpdir() with no --add-dir, so it has no project files in reach.
 */
export async function runAntigravityText(prompt: string, options: { model: string; jsonSchema?: object }): Promise<AntigravityTextResult> {
  const args = ['--model', options.model, '--mode', 'plan', ...(options.jsonSchema ? ['--json-schema', JSON.stringify(options.jsonSchema)] : [])];
  const outcome = await runAgyTurn(prompt, args, os.tmpdir(), TIMEOUT_MS);
  if (outcome.spawnError) throw outcome.spawnError;
  const result = outcome.result;
  if (result?.status !== 'SUCCESS') {
    throw new Error(`Antigravity returned ${result?.status ?? 'no result'}: ${String(result?.error || result?.response || outcome.stderr).slice(0, 300)}`);
  }
  if (options.jsonSchema && result.structured_output == null) {
    throw new Error('Antigravity returned no structured_output for a --json-schema call.');
  }
  return {
    text: String(result.response ?? ''),
    structured: result.structured_output ?? null,
    inputTokens: result.usage?.input_tokens ?? 0,
    outputTokens: result.usage?.output_tokens ?? 0,
  };
}

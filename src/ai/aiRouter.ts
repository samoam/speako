import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { recordAiUsage } from '../storage/aiUsageRepository';
import { runClaudeText, ClaudeTextModel } from './claudeText';

type Route = { provider: 'claude'; model: ClaudeTextModel } | { provider: 'gemini'; model: 'fast' | 'main' };

const CLAUDE_HAIKU: Route = { provider: 'claude', model: 'haiku' };
const CLAUDE_SONNET: Route = { provider: 'claude', model: 'sonnet' };
const GEMINI_FAST: Route = { provider: 'gemini', model: 'fast' };
const GEMINI_MAIN: Route = { provider: 'gemini', model: 'main' };

/**
 * Gemini is the only metered text provider (Claude Code CLI is a flat
 * subscription, Jev is cheap per call and handled outside this table since it
 * only classifies), so every prose task tries Claude first and keeps Gemini as
 * the failover. Haiku for short, mechanical output; Sonnet where the input is a
 * whole transcript/many sources or the output is judgment-heavy. Only work
 * that can't wait ~5s for a CLI spawn (see claudeText.ts) stays Gemini-first,
 * and it lives at its call site, not here.
 */
const ROUTES = {
  meetingState: [CLAUDE_HAIKU, GEMINI_FAST],
  liveSuggestion: [CLAUDE_HAIKU, GEMINI_FAST],
  triageProse: [CLAUDE_HAIKU, GEMINI_FAST],
  draft: [CLAUDE_HAIKU, GEMINI_FAST],
  chat: [CLAUDE_HAIKU, GEMINI_FAST],
  briefing: [CLAUDE_HAIKU, GEMINI_FAST],
  chapters: [CLAUDE_HAIKU, GEMINI_FAST],
  buildTriage: [CLAUDE_HAIKU, GEMINI_FAST],
  sessionSummary: [CLAUDE_SONNET, GEMINI_MAIN],
  prep: [CLAUDE_SONNET, GEMINI_MAIN],
  coaching: [CLAUDE_SONNET, GEMINI_MAIN],
  audioScript: [CLAUDE_SONNET, GEMINI_MAIN],
  knowledgeQa: [CLAUDE_SONNET, GEMINI_MAIN],
  reviewMerge: [CLAUDE_SONNET, GEMINI_MAIN],
} satisfies Record<string, Route[]>;

export type AiTask = keyof typeof ROUTES;

/**
 * Gemini's responseSchema is an OpenAPI subset (`nullable: true`); Claude's
 * --json-schema is plain JSON Schema (`type: [..., 'null']`). Every schema in
 * this codebase is written in the Gemini form, so it's converted, not duplicated.
 */
export function toJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const { nullable, ...rest } = schema;
  const out: any = {};
  for (const [k, v] of Object.entries(rest)) out[k] = toJsonSchema(v);
  if (nullable && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

interface RouteResult {
  text: string;
  structured: any;
  /** Which model actually answered — e.g. "claude-sonnet" or the configured Gemini model name. */
  model: string;
}

async function callRoute(route: Route, feature: string, prompt: string, schema?: object): Promise<RouteResult> {
  if (route.provider === 'claude') {
    const result = await runClaudeText(prompt, { model: route.model, jsonSchema: schema ? toJsonSchema(schema) : undefined });
    recordAiUsage('claude', feature, result.inputTokens, result.outputTokens);
    return { text: result.text, structured: result.structured, model: `claude-${route.model}` };
  }
  const model = route.model === 'fast' ? config.geminiFastModel : config.geminiModel;
  const response = await getGeminiClient().models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
      // Gemini is only ever the failover here, so it runs with thinking
      // minimized on every tier — thinkingBudget: 0 is rejected (400), 1 is
      // the smallest accepted budget.
      thinkingConfig: { thinkingBudget: 1 },
    },
  });
  logGeminiUsage(feature, response);
  const text = response.text ?? '';
  return { text, structured: schema ? JSON.parse(text || '{}') : null, model };
}

async function runRoutes(task: AiTask, feature: string, prompt: string, schema?: object): Promise<RouteResult> {
  let lastError: Error | null = null;
  for (const route of ROUTES[task]) {
    if (route.provider === 'claude' && !config.claudeTextRouting) continue;
    // Skipped rather than attempted: confirmed that the SDK happily sends a
    // keyless request, which goes out over the network and 403s
    // (PERMISSION_DENIED, "unregistered callers").
    if (route.provider === 'gemini' && !config.geminiApiKey) continue;
    try {
      return await callRoute(route, feature, prompt, schema);
    } catch (err: any) {
      lastError = err;
      console.error(`[ai-router] ${feature} via ${route.provider}/${route.model} failed:`, err.message);
    }
  }
  throw lastError ?? new Error(NO_TEXT_PROVIDER_MESSAGE);
}

/** Replaces the old `if (!config.geminiApiKey)` short-circuits: those features now work from the Claude route alone. */
export function hasTextProvider(): boolean {
  return config.claudeTextRouting || !!config.geminiApiKey;
}

export const NO_TEXT_PROVIDER_MESSAGE = 'No AI text provider is available — enable CLAUDE_TEXT_ROUTING or set GEMINI_API_KEY (see NOTES.md).';

/** `feature` is the usage label (same one logGeminiUsage used before this router existed, so gemini_usage history stays comparable). */
export async function generateJson<T>(task: AiTask, feature: string, prompt: string, schema: object): Promise<T> {
  return (await runRoutes(task, feature, prompt, schema)).structured as T;
}

/** generateJson plus the model that answered, for callers that persist it (e.g. summaries.model_used). */
export async function generateJsonWithModel<T>(task: AiTask, feature: string, prompt: string, schema: object): Promise<{ value: T; model: string }> {
  const result = await runRoutes(task, feature, prompt, schema);
  return { value: result.structured as T, model: result.model };
}

export async function generateText(task: AiTask, feature: string, prompt: string): Promise<string> {
  return (await runRoutes(task, feature, prompt)).text.trim();
}

import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { recordAiUsage } from '../storage/aiUsageRepository';
import { runClaudeText, ClaudeTextModel } from './claudeText';
import { runAntigravityText } from './antigravityText';

type Route =
  | { provider: 'claude'; model: ClaudeTextModel }
  | { provider: 'antigravity'; model: string }
  | { provider: 'gemini'; model: 'fast' | 'main' };

const CLAUDE_HAIKU: Route = { provider: 'claude', model: 'haiku' };
const CLAUDE_SONNET: Route = { provider: 'claude', model: 'sonnet' };
// Model ids from `agy models` (agy 1.2.14) — agy self-updates and its list
// changes, so a retired id just fails over to Gemini rather than breaking.
const AGY_FLASH: Route = { provider: 'antigravity', model: 'gemini-3.8-flash-low' };
const AGY_PRO: Route = { provider: 'antigravity', model: 'gemini-3.1-pro-low' };
const GEMINI_FAST: Route = { provider: 'gemini', model: 'fast' };
const GEMINI_MAIN: Route = { provider: 'gemini', model: 'main' };

/**
 * Gemini is the only metered text provider (Claude Code CLI and the
 * Antigravity CLI are flat subscriptions, Jev is cheap per call and handled
 * outside this table since it only classifies), so every prose task tries
 * Claude first, Antigravity next (overflow, e.g. when Claude is rate-limited),
 * and keeps Gemini as the last resort. Haiku for short, mechanical output; Sonnet where the input is a
 * whole transcript/many sources or the output is judgment-heavy. Only work
 * that can't wait ~5s for a CLI spawn (see claudeText.ts) stays Gemini-first,
 * and it lives at its call site, not here.
 */
const ROUTES = {
  meetingState: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  liveSuggestion: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  triageProse: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  draft: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  chat: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  briefing: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  chapters: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  buildTriage: [CLAUDE_HAIKU, AGY_FLASH, GEMINI_FAST],
  // No Antigravity step: its web search hasn't been verified, and a route
  // that can't search would answer a fact-check from memory.
  webResearch: [CLAUDE_HAIKU, GEMINI_FAST],
  sessionSummary: [CLAUDE_SONNET, AGY_PRO, GEMINI_MAIN],
  prep: [CLAUDE_SONNET, AGY_PRO, GEMINI_MAIN],
  coaching: [CLAUDE_SONNET, AGY_PRO, GEMINI_MAIN],
  audioScript: [CLAUDE_SONNET, AGY_PRO, GEMINI_MAIN],
  knowledgeQa: [CLAUDE_SONNET, AGY_PRO, GEMINI_MAIN],
  reviewMerge: [CLAUDE_SONNET, AGY_PRO, GEMINI_MAIN],
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

interface CallOptions {
  schema?: object;
  /** Claude's WebSearch tool on the Claude route, Gemini's Google Search grounding on the failover. */
  webSearch?: boolean;
}

async function callRoute(route: Route, feature: string, prompt: string, opts: CallOptions): Promise<RouteResult> {
  const { schema, webSearch } = opts;
  if (route.provider === 'claude') {
    const result = await runClaudeText(prompt, { model: route.model, jsonSchema: schema ? toJsonSchema(schema) : undefined, webSearch });
    recordAiUsage('claude', feature, result.inputTokens, result.outputTokens);
    return { text: result.text, structured: result.structured, model: `claude-${route.model}` };
  }
  if (route.provider === 'antigravity') {
    const result = await runAntigravityText(prompt, { model: route.model, jsonSchema: schema ? toJsonSchema(schema) : undefined });
    recordAiUsage('antigravity', feature, result.inputTokens, result.outputTokens);
    return { text: result.text, structured: result.structured, model: `antigravity-${route.model}` };
  }
  const model = route.model === 'fast' ? config.geminiFastModel : config.geminiModel;
  const response = await getGeminiClient().models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(webSearch ? { tools: [{ googleSearch: {} }] } : {}),
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

async function runRoutes(task: AiTask, feature: string, prompt: string, opts: CallOptions): Promise<RouteResult> {
  let lastError: Error | null = null;
  for (const route of ROUTES[task]) {
    if (route.provider === 'claude' && !config.claudeTextRouting) continue;
    if (route.provider === 'antigravity' && !config.antigravityTextRouting) continue;
    // Skipped rather than attempted: confirmed that the SDK happily sends a
    // keyless request, which goes out over the network and 403s
    // (PERMISSION_DENIED, "unregistered callers").
    if (route.provider === 'gemini' && !config.geminiApiKey) continue;
    try {
      return await callRoute(route, feature, prompt, opts);
    } catch (err: any) {
      lastError = err;
      console.error(`[ai-router] ${feature} via ${route.provider}/${route.model} failed:`, err.message);
    }
  }
  throw lastError ?? new Error(NO_TEXT_PROVIDER_MESSAGE);
}

/** Replaces the old `if (!config.geminiApiKey)` short-circuits: those features now work from the Claude route alone. */
export function hasTextProvider(): boolean {
  return config.claudeTextRouting || config.antigravityTextRouting || !!config.geminiApiKey;
}

export const NO_TEXT_PROVIDER_MESSAGE = 'No AI text provider is available — enable CLAUDE_TEXT_ROUTING or set GEMINI_API_KEY (see NOTES.md).';

/** `feature` is the usage label (same one logGeminiUsage used before this router existed, so gemini_usage history stays comparable). */
export async function generateJson<T>(task: AiTask, feature: string, prompt: string, schema: object, opts: { webSearch?: boolean } = {}): Promise<T> {
  return (await runRoutes(task, feature, prompt, { ...opts, schema })).structured as T;
}

/** generateJson plus the model that answered, for callers that persist it (e.g. summaries.model_used). */
export async function generateJsonWithModel<T>(task: AiTask, feature: string, prompt: string, schema: object): Promise<{ value: T; model: string }> {
  const result = await runRoutes(task, feature, prompt, { schema });
  return { value: result.structured as T, model: result.model };
}

export async function generateText(task: AiTask, feature: string, prompt: string, opts: { webSearch?: boolean } = {}): Promise<string> {
  return (await runRoutes(task, feature, prompt, opts)).text.trim();
}

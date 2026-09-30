import { config } from '../config';
import { recordAiUsage } from '../storage/aiUsageRepository';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Confirmed live (2026-09-30): choice `criteria` is a map of option name ->
 * description. Passing `{ options: [...] }` instead doesn't error — Jev just
 * answers "options" as the only choice, so a wrong shape fails silently.
 */
export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string };

export type JevAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number };

export function isJevConfigured(): boolean {
  return !!config.typesafeApiKey;
}

/** One POST per call, every question answered against the same `state` text. Throws on any non-2xx or missing answer — callers own their fallback. */
export async function askJev(state: string, questions: Record<string, JevQuestion>, feature = 'jev'): Promise<Record<string, JevAnswer>> {
  if (!isJevConfigured()) throw new Error('TYPESAFE_API_KEY is not configured.');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.typesafeApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  recordAiUsage('jev', feature, body?.usage?.input_tokens ?? 0, body?.usage?.output_tokens ?? 0);
  const answers = body?.answers ?? {};
  for (const key of Object.keys(questions)) {
    if (!answers[key]) throw new Error(`TypeSafe API returned no answer for "${key}".`);
  }
  return answers;
}

export function jevChoice<T extends string>(answer: JevAnswer | undefined, allowed: readonly T[]): T | null {
  if (answer?.type !== 'choice') return null;
  return (allowed as readonly string[]).includes(answer.choice) ? (answer.choice as T) : null;
}

export function jevTrue(answer: JevAnswer | undefined): boolean | null {
  return answer?.type === 'noul' ? answer.noul >= 0.5 : null;
}

export type UrgencySignal = 'none' | 'soon' | 'urgent';
export const URGENCY_SIGNALS = ['none', 'soon', 'urgent'] as const;

/** Same three buckets the Gemini triage schemas use, so Jev and the Gemini fallback feed teamsMessageUrgency/emailMessageUrgency (taskSync.ts) identically. */
export const URGENCY_QUESTION: JevQuestion = {
  type: 'choice',
  instructions: 'How quickly does the reader need to act on this message?',
  criteria: {
    urgent: 'Explicitly demands fast action: ASAP, urgent, blocking, a same-day deadline, or an escalation tone',
    soon: 'A clear but not immediate deadline or expectation, e.g. by end of week',
    none: 'No deadline or time pressure',
  },
};

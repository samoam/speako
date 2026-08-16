import { config } from '../config';
import { onSettingsChanged } from '../settingsStore';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleGenAI } = require('@google/genai');

let client: any = null;

/** Shared across every Gemini-consuming module — invalidated on settings changes so a new API key takes effect without a restart. */
export function getGeminiClient(): any {
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

onSettingsChanged(() => {
  client = null;
});

/**
 * The @google/genai SDK throws with `.message` set to the raw JSON error
 * body verbatim (e.g. `{"error":{"code":503,"message":"...","status":
 * "UNAVAILABLE"}}`) rather than a clean string — confirmed repeatedly by
 * real 503/UNAVAILABLE responses surfacing that exact blob straight into
 * user-facing alerts. Extracts just the human-readable message when the
 * error looks like that shape; falls back to the raw message untouched for
 * anything else (a real thrown Error, a plain string, etc.) so this is safe
 * to wrap around any caught Gemini-call error.
 */
export function cleanGeminiErrorMessage(err: any): string {
  const raw = err?.message ?? String(err);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
  } catch {
    // Not JSON — already a plain message, use as-is.
  }
  return raw;
}

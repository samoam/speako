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

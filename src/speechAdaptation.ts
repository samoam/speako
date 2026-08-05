import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

interface PhraseHintsConfig {
  version: number;
  classes: Record<string, string[]>;
}

const DEFAULT_BOOST = 15;

function loadPhraseHints(): PhraseHintsConfig | null {
  if (!fs.existsSync(config.phraseHintsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.phraseHintsPath, 'utf8'));
  } catch (err: any) {
    console.error(`[speech-adaptation] failed to parse ${config.phraseHintsPath}:`, err.message);
    return null;
  }
}

/**
 * Builds the `adaptation` field for a v2 RecognitionConfig from
 * config/phrase-hints.json, biasing recognition toward domain vocabulary
 * (project names, tools, acronyms). Returns undefined if the file is
 * missing/empty so callers can omit the field entirely.
 *
 * Confirmed empirically that chirp_3 accepts this in streaming mode, and that
 * it works by injecting the phrase list directly into the model's internal
 * prompt (chirp_3's recognition is LLM-based under the hood) rather than
 * classic n-gram language-model boosting — see NOTES.md.
 */
export function buildAdaptationConfig(): { phraseSets: [{ inlinePhraseSet: { phrases: { value: string; boost: number }[] } }] } | undefined {
  const hints = loadPhraseHints();
  if (!hints) return undefined;

  const phrases = Object.values(hints.classes)
    .flat()
    .map((value) => ({ value, boost: DEFAULT_BOOST }));

  if (phrases.length === 0) return undefined;
  return { phraseSets: [{ inlinePhraseSet: { phrases } }] };
}

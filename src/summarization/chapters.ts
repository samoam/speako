import { config } from '../config';
import { TranscriptSegment } from '../types';
import { toPlainText } from '../transcriptFormat';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';

const CHAPTERS_PROMPT = `You are splitting a speaker-labeled, timestamped ([mm:ss]) meeting transcript into
chapters — logical topic sections a listener could jump between. Aim for 3-8 chapters for a typical meeting;
fewer for a short one. Each chapter needs:
- "startTime": the exact "[mm:ss]" timestamp (as it appears in the transcript, without the brackets) where
  that topic begins — must be the timestamp of an actual line in the transcript, not an estimate.
- "title": a short (3-6 word) topic label.
- "summary": one sentence on what was covered in this chapter.
The first chapter must start at the transcript's first timestamp. Order chapters chronologically.`;

// Object-wrapped (never a bare top-level array) — a bare top-level `type:'array'`
// responseSchema was confirmed to trigger a real 400 INVALID_ARGUMENT from the
// live Gemini API (see ACTION_ITEMS_SCHEMA), so every schema in this app wraps
// its list in a named object property instead.
const CHAPTERS_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startTime: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['startTime', 'title', 'summary'],
      },
    },
  },
  required: ['chapters'],
};

export interface Chapter {
  startMs: number;
  title: string;
  summary: string;
}

/** Parses a "[mm:ss]"-style timestamp (with or without brackets) back to milliseconds — the inverse of transcriptFormat.ts's fmtTime. Returns null if it doesn't match that shape (a model hallucination), so callers can drop the chapter rather than store a bogus timestamp. */
function parseTimestamp(value: string): number | null {
  const match = value.match(/(\d+):(\d{2})/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return (minutes * 60 + seconds) * 1000;
}

/**
 * One on-demand Gemini call per session (POST /api/sessions/:id/chapters),
 * same shape as summarize.ts/analyzeConversation.ts — mechanical structured
 * extraction from a transcript already fully in hand, so it's routed to the
 * cheaper model tier with thinking disabled (see docs/gemini-cost-optimization).
 */
export async function detectChapters(segments: TranscriptSegment[]): Promise<Chapter[]> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

  const transcript = toPlainText(segments);
  const response = await getGeminiClient().models.generateContent({
    model: config.geminiFastModel,
    contents: `${CHAPTERS_PROMPT}\n\nTranscript:\n${transcript}`,
    // thinkingBudget: 0 is currently rejected (400) by gemini-flash-latest — 1 is the smallest accepted budget.
    config: { responseMimeType: 'application/json', responseSchema: CHAPTERS_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
  });
  logGeminiUsage('detectChapters', response);

  const parsed = JSON.parse(response.text ?? '{}');
  const rawChapters: { startTime: string; title: string; summary: string }[] = parsed.chapters ?? [];

  return rawChapters
    .map((c) => {
      const startMs = parseTimestamp(c.startTime);
      return startMs === null ? null : { startMs, title: c.title, summary: c.summary };
    })
    .filter((c): c is Chapter => c !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

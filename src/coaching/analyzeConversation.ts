import { config } from '../config';
import { toPlainText } from '../transcriptFormat';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { getSegmentsForSession } from '../storage/segmentRepository';
import { FeedbackPoint } from '../storage/coachingRepository';
import { TranscriptSegment } from '../types';

const FILLER_WORD_REGEX = /\b(um+|uh+|like|you know|sort of|kind of|basically|actually|i mean)\b/gi;
const MAX_FILLER_EXAMPLES = 3;

const COACHING_PROMPT = `You are a communication coach reviewing a transcript of a meeting. "You" is the
person being coached; other speakers are whoever they were talking with. Give 2-5 specific, actionable
feedback points on how "You" communicated — clarity, pacing, structure, and follow-through on any
commitments they mentioned. For each point:
- "category": one of clarity, pacing, filler_words, talk_time, follow_through.
- "observation": a specific, concrete observation — point at what actually happened, not generic advice.
- "quote": a short verbatim quote from "You"'s speech that the observation is based on, or null if it's
  based on an overall pattern rather than one moment.
- "suggestion": a concrete, actionable suggestion.
Be constructive. If "You"'s communication was already clear and effective, say so briefly rather than
inventing criticism to fill the list — an empty or short list is a valid, honest result.`;

const COACHING_SCHEMA = {
  type: 'object',
  properties: {
    feedbackPoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['clarity', 'pacing', 'filler_words', 'talk_time', 'follow_through'] },
          observation: { type: 'string' },
          quote: { type: 'string', nullable: true },
          suggestion: { type: 'string' },
        },
        required: ['category', 'observation', 'suggestion'],
      },
    },
  },
  required: ['feedbackPoints'],
};

export interface AnalyzedConversation {
  talkTimeRatio: number;
  fillerWordCount: number;
  fillerWordExamples: string[];
  youInterruptedOthersCount: number;
  othersInterruptedYouCount: number;
  feedbackPoints: FeedbackPoint[];
}

/**
 * Deterministic cross-talk count from the two channel-based speaker streams
 * ('You' mic channel, 'Others' system-audio channel — see types.ts). Within
 * one speaker's own stream, finalized segments are monotonic/non-overlapping
 * (confirmed in streamManager.ts), so any segment that starts before the
 * OTHER speaker's most recent segment has ended is genuine cross-talk: sort
 * both streams together by startMs and sweep, tracking each speaker's latest
 * endMs seen so far. Silently ignores any other speaker label (post-
 * diarization 'Speaker N' sessions) since only two channels can overlap here.
 */
export function countInterruptions(segments: TranscriptSegment[]): {
  youInterruptedOthersCount: number;
  othersInterruptedYouCount: number;
} {
  const relevant = segments.filter((s) => s.speaker === 'You' || s.speaker === 'Others').sort((a, b) => a.startMs - b.startMs);

  const lastEndMs: Record<'You' | 'Others', number> = { You: -Infinity, Others: -Infinity };
  let youInterruptedOthersCount = 0;
  let othersInterruptedYouCount = 0;

  for (const segment of relevant) {
    const speaker = segment.speaker as 'You' | 'Others';
    const other = speaker === 'You' ? 'Others' : 'You';
    if (segment.startMs < lastEndMs[other]) {
      if (speaker === 'You') youInterruptedOthersCount++;
      else othersInterruptedYouCount++;
    }
    lastEndMs[speaker] = Math.max(lastEndMs[speaker], segment.endMs);
  }

  return { youInterruptedOthersCount, othersInterruptedYouCount };
}

/**
 * Deterministic metrics (talk-time, filler words) come straight from stored
 * segments — nothing to get wrong, no Gemini needed. Only the qualitative
 * feedbackPoints require a model call, and that call is fail-soft: a broken
 * key or a Gemini hiccup still returns the two deterministic metrics rather
 * than failing the whole request.
 *
 * Speaker labels here are the live channel-based 'You'/'Others' (see
 * src/types.ts) — if a session has since been through post-session speaker
 * diarization, those labels are replaced with 'Speaker N' and this will find
 * no "You" segments to analyze (same limitation other 'You'-keyed live
 * features share, e.g. session.ts's anticipated-answer matching).
 */
export async function analyzeConversation(sessionId: string): Promise<AnalyzedConversation | null> {
  const segments = getSegmentsForSession(sessionId);
  const yourSegments = segments.filter((s) => s.speaker === 'You');
  if (yourSegments.length === 0) return null;

  const totalMs = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const yourMs = yourSegments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const talkTimeRatio = totalMs > 0 ? yourMs / totalMs : 0;

  let fillerWordCount = 0;
  const fillerWordExamples: string[] = [];
  for (const segment of yourSegments) {
    const matches = segment.text.match(FILLER_WORD_REGEX);
    if (matches) {
      fillerWordCount += matches.length;
      if (fillerWordExamples.length < MAX_FILLER_EXAMPLES) fillerWordExamples.push(segment.text);
    }
  }

  const { youInterruptedOthersCount, othersInterruptedYouCount } = countInterruptions(segments);

  if (!config.geminiApiKey) {
    return { talkTimeRatio, fillerWordCount, fillerWordExamples, youInterruptedOthersCount, othersInterruptedYouCount, feedbackPoints: [] };
  }

  try {
    const transcript = toPlainText(segments);
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiModel,
      contents: `${COACHING_PROMPT}\n\nTranscript:\n${transcript}`,
      // thinkingBudget: 0 (fully disabled) is currently rejected with a 400 by
      // gemini-flash-latest — confirmed via direct API testing; 1 is the
      // smallest budget this model still accepts, so it's the closest
      // available approximation of "disabled" until that changes.
      config: { responseMimeType: 'application/json', responseSchema: COACHING_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
    });
    logGeminiUsage('analyzeConversation', response);
    const parsed = JSON.parse(response.text ?? '{}');
    return {
      talkTimeRatio,
      fillerWordCount,
      fillerWordExamples,
      youInterruptedOthersCount,
      othersInterruptedYouCount,
      feedbackPoints: (parsed.feedbackPoints ?? []).map((p: any) => ({ ...p, quote: p.quote ?? null })),
    };
  } catch (err: any) {
    console.error(`[coaching] feedback generation failed for session ${sessionId}:`, err.message);
    return { talkTimeRatio, fillerWordCount, fillerWordExamples, youInterruptedOthersCount, othersInterruptedYouCount, feedbackPoints: [] };
  }
}

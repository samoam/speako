import { config } from '../config';
import { toPlainText } from '../transcriptFormat';
import { TranscriptSegment } from '../types';
import { getMeetingState, upsertMeetingState, OpenItem } from '../storage/meetingStateRepository';
import { countSegmentsForSession, getSegmentsForSessionSince } from '../storage/segmentRepository';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';

const MEETING_STATE_PROMPT = `You maintain running state for a live meeting so later reasoning steps don't have to re-read the whole transcript.
You'll get the PREVIOUS SUMMARY, the PREVIOUS OPEN ITEMS (each with a stable id), and the NEW TRANSCRIPT said since the last update.

Update the state:
- "rollingSummary": merge the new transcript into the previous summary (don't just append — integrate it). Keep it compact: topics covered, decisions made, open questions. A few sentences per major topic, not a transcript.
- "openItems": start from PREVIOUS OPEN ITEMS. For each one, carry it over UNCHANGED (same id, same description) unless the NEW TRANSCRIPT clearly resolves/answers it — in that case, omit it entirely (it's resolved, don't include it). Add a new item (invent a short new id, e.g. "q1"/"c2"/"f3") for each NEW unresolved question, vague commitment (no clear owner/deadline), or flagged factual claim worth tracking that appears in the NEW TRANSCRIPT. Don't duplicate an item that's materially the same as one already carried over.
Categories for openItems: "question" (unanswered question), "commitment" (vague commitment/requirement without owner/deadline), "flagged_claim" (a claim worth remembering was made).`;

const MEETING_STATE_SCHEMA = {
  type: 'object',
  properties: {
    rollingSummary: { type: 'string' },
    openItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: ['question', 'commitment', 'flagged_claim'] },
        },
        required: ['id', 'description', 'category'],
      },
    },
  },
  required: ['rollingSummary', 'openItems'],
};

export interface MeetingStateSnapshot {
  rollingSummary: string;
  openItems: OpenItem[];
}

/** Empty/default state — returned for a session with no meeting_state row yet (e.g. right at session start) rather than null, so callers can use it unconditionally as prompt context. */
const EMPTY_STATE: MeetingStateSnapshot = { rollingSummary: '', openItems: [] };

export function getMeetingStateSnapshot(sessionId: string): MeetingStateSnapshot {
  const state = getMeetingState(sessionId);
  return state ? { rollingSummary: state.rollingSummary, openItems: state.openItems } : EMPTY_STATE;
}

/**
 * Seeds a session's rolling summary with a pre-meeting prep brief, before
 * any transcript exists — unlike updateMeetingState, which always requires
 * new segments and returns early with zero. Called once by PrepService when
 * a prep run completes; lastUpdatedSegmentCount stays 0 so the first real
 * updateMeetingState call (once segments exist) still picks up from segment
 * one rather than skipping transcript that predates the seed.
 */
export function seedMeetingState(sessionId: string, prepBriefText: string): void {
  upsertMeetingState(sessionId, prepBriefText, [], 0);
}

/**
 * Incrementally updates a session's rolling summary + open-items registry
 * (Improvements Phase §2) from whatever transcript has accumulated since the
 * last update. Called on a segment-count cadence (see config.
 * meetingStateUpdateEverySegments) rather than per-segment, to keep this
 * extra LLM call from becoming a latency bottleneck in the live pipeline —
 * same rationale as Phase 3's trigger cooldown/rate-limit. Never throws;
 * logs and gives up on failure so a state-update hiccup can't affect live
 * transcription/triggers.
 */
export async function updateMeetingState(sessionId: string): Promise<void> {
  if (!config.meetingStateEnabled || !config.geminiApiKey) return;

  try {
    const existing = getMeetingState(sessionId);
    const previousSummary = existing?.rollingSummary ?? '';
    const previousOpenItems = existing?.openItems ?? [];
    const sinceCount = existing?.lastUpdatedSegmentCount ?? 0;

    const newSegments = getSegmentsForSessionSince(sessionId, sinceCount);
    if (newSegments.length === 0) return;

    const newText = toPlainText(newSegments as TranscriptSegment[]);
    const prompt = `${MEETING_STATE_PROMPT}\n\nPREVIOUS SUMMARY:\n${previousSummary || '(none yet)'}\n\nPREVIOUS OPEN ITEMS:\n${JSON.stringify(previousOpenItems)}\n\nNEW TRANSCRIPT:\n${newText}`;

    const response = await getGeminiClient().models.generateContent({
      // Fires every config.meetingStateUpdateEverySegments segments for the
      // whole meeting — mechanical merge/extraction task, not creative
      // reasoning, so the cheaper tier + disabled thinking cost nothing in
      // quality here. See docs/gemini-cost-optimization.
      model: config.geminiFastModel,
      contents: prompt,
      // thinkingBudget: 0 is currently rejected (400) by gemini-flash-latest/fast tier — 1 is the smallest accepted budget.
      config: { responseMimeType: 'application/json', responseSchema: MEETING_STATE_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
    });
    logGeminiUsage('updateMeetingState', response);

    const parsed = JSON.parse(response.text ?? '{}');
    const totalCount = countSegmentsForSession(sessionId);
    upsertMeetingState(sessionId, parsed.rollingSummary ?? previousSummary, parsed.openItems ?? previousOpenItems, totalCount);
  } catch (err: any) {
    console.error(`[meeting-state] update failed for session ${sessionId}:`, err.message);
  }
}

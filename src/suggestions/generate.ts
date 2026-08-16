import { config } from '../config';
import { retrieve } from '../rag/rag';
import { searchCode } from '../codebase/searchCode';
import { isLocalCodebaseConfigured } from '../codebase/indexCodebase';
import { TriggerEvent } from '../storage/triggerRepository';
import { getMeetingStateSnapshot } from '../state/meetingState';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';

// Category-specific prompts (spec §7.2) — each asks for exactly one thing, matching
// how differently each trigger category should be handled rather than one generic prompt.
const CATEGORY_PROMPTS: Record<string, string> = {
  unanswered_question: 'Suggest one concise follow-up question to re-raise this unanswered question. Output only the question, nothing else.',
  factual_claim:
    'Based ONLY on the retrieved context below, does this claim clearly align or clearly conflict with it? ' +
    'If there is a clear match or conflict, state it in one sentence. If the context is empty, unrelated, or ' +
    'you are not confident either way, output exactly SKIP and nothing else.',
  decision_point: 'Suggest one question to confirm this decision is fully scoped (e.g. missing owner or timeline). Output only the question, nothing else.',
  vagueness: 'Suggest one clarifying question to pin down the missing owner, deadline, or specifics. Output only the question, nothing else.',
  tone_shift: 'Suggest one neutral, low-pressure check-in question appropriate to this sentiment shift. Output only the question, nothing else.',
  code_reference:
    'Based ONLY on the retrieved local codebase snippets below, is there something directly relevant worth surfacing — ' +
    "what a mentioned function/file actually does, or a mismatch between what's being described and the real code? " +
    'State it in one sentence. If nothing retrieved is clearly relevant, output exactly SKIP and nothing else.',
};

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface GeneratedSuggestion {
  text: string;
  citation: string | null;
}

/**
 * Generates a proactive suggestion for a fired trigger, grounded where it matters.
 * Only "factual_claim" is suppressed outright when retrieval finds nothing (spec
 * §7.1 point 4 — a claim check without grounding is a low-quality guess). The
 * other categories are advisory clarifying questions that are still useful without
 * historical grounding, so they proceed regardless and just attach a citation
 * opportunistically when something relevant turns up.
 */
export async function generateSuggestion(trigger: TriggerEvent, segmentText: string): Promise<GeneratedSuggestion | null> {
  const promptInstruction = CATEGORY_PROMPTS[trigger.category];
  if (!promptInstruction) return null;

  // code_reference is grounded in the local codebase index, not past-meeting
  // RAG — separate retrieval source, but everything past this block (meeting-
  // state suppression, prompt shape, Gemini call) is shared with every other
  // category. Same "suppress outright when there's nothing to ground it in"
  // rule factual_claim already uses for past-meeting context.
  let contextBlock: string;
  let citation: string | null;
  if (trigger.category === 'code_reference') {
    if (!isLocalCodebaseConfigured()) return null;
    const matches = await searchCode(segmentText, 3);
    if (matches.length === 0) return null;
    contextBlock = matches.map((m) => `- (${m.repoName}/${m.filePath}) ${m.text}`).join('\n');
    citation = matches.map((m) => `${m.repoName}/${m.filePath}`).join(', ');
  } else {
    const retrieval = await retrieve(segmentText, trigger.sessionId);
    if (trigger.category === 'factual_claim' && retrieval.suppressed) {
      return null;
    }
    contextBlock = retrieval.chunks.length
      ? retrieval.chunks.map((c) => `- (${c.sessionName || 'a past session'}) ${c.text}`).join('\n')
      : '(no relevant past context found)';
    citation = retrieval.chunks.length
      ? retrieval.chunks.map((c) => `${c.sessionName || 'Past session'} (${fmtMs(c.startMs)})`).join(', ')
      : null;
  }

  // Check THIS meeting's own state (not just past sessions via RAG above)
  // so a suggestion isn't a duplicate of one already open, or one that was
  // already resolved a few minutes ago in the same conversation — the
  // stateless per-window trigger detection has no way to know that on its own.
  const state = getMeetingStateSnapshot(trigger.sessionId);
  const openItemsBlock = state.openItems.length
    ? state.openItems.map((i) => `- [${i.category}] ${i.description}`).join('\n')
    : '(none tracked yet)';
  const suppressionInstruction =
    'If this same point is already listed below as an OPEN ITEM from earlier in this meeting, or the MEETING SUMMARY SO FAR shows it was already resolved, output exactly SKIP and nothing else — do not repeat it.';

  const contextLabel = trigger.category === 'code_reference' ? 'Retrieved code from your local codebase' : 'Retrieved context from past sessions';
  const prompt = `${promptInstruction}\n${suppressionInstruction}\n\nCurrent moment: "${segmentText}"\nWhy this was flagged: ${trigger.reason}\n\nMeeting summary so far:\n${state.rollingSummary || '(nothing yet)'}\n\nOpen items already tracked this meeting:\n${openItemsBlock}\n\n${contextLabel}:\n${contextBlock}`;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: prompt,
  });
  logGeminiUsage('generateSuggestion', response);

  const text = (response.text ?? '').trim();
  if (!text || text.toUpperCase() === 'SKIP') return null;

  return { text, citation };
}

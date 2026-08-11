import { config } from '../config';
import { MEETING_TYPE_LABELS, MeetingType } from './meetingTypes';
import { WorkflowSource } from './workflows/types';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { buildRawContextBlock } from './rawContext';

const SYNTHESIZE_PROMPT = `You are preparing a concise pre-meeting brief for someone about to join a meeting. You'll be given raw context pulled from several sources (Jira, Confluence, past meeting notes, code activity, web search, etc) for a specific meeting type.

Synthesize this into a SHORT, STRUCTURED brief — not a dump of the raw sources. Organize it under headers relevant to the meeting type (pick headers that fit what's actually in the sources, skip headers with nothing to say). Be concrete and specific (ticket keys, names, numbers) over generic. If a source contributed nothing useful, don't mention it. Plain text with markdown-style "## Header" sections, no preamble.`;

/**
 * Per-type emphasis, distinct from the shared structural instructions above —
 * standups need brevity, design reviews need questions, retros need prompts
 * rather than conclusions, etc. Without this, every brief reads the same
 * regardless of meeting type; the type-specific workflows already gather
 * different sources, but the synthesis step was flattening that distinction.
 */
const TYPE_EMPHASIS: Record<MeetingType, string> = {
  standup: 'Keep this terse and scannable — standups are time-boxed to ~15 minutes. Lead with blockers, then a brief "since last standup" digest. No long paragraphs.',
  sprint_planning: 'Structure this to support an active scoping/estimation session, not just inform. Include enough detail per item (title, brief description, estimate if known) that the reader doesn\'t need to look each one up separately. Clearly separate carryover items from fresh backlog candidates.',
  sprint_review: 'Focus on outcomes: what shipped and is demo-ready, what didn\'t and why, framed against what was originally planned. Avoid a dry status recitation — the reader should walk in already knowing what to expect to see.',
  retro: 'Frame everything as PROMPTS for discussion, not conclusions or verdicts — retros should surface the team\'s own perspective, not have it pre-decided by tooling. Explicitly note the status of action items from the previous retro (done / not done). If friction signals (repeated status bounces, negative sentiment) are present, present them as things worth asking about, not diagnoses.',
  one_on_one: 'This is relationship-and-continuity-focused, not task-tracking — minimize status-update framing. Recap what mattered last time and what\'s still open, but don\'t just list their tickets.',
  design_dev: 'The most valuable output here is a well-formed list of discussion questions and risks, not a passive summary. Prioritize surfacing technical risk, open questions, and anything that contradicts or complicates the proposal.',
  generic: 'Keep this lightweight — group the most relevant snippets by source rather than imposing heavy structure on what may be sparse context.',
};

/**
 * One Gemini call per prep run (§5.1 step 4) — turns raw per-source results
 * into the brief that gets persisted and seeded into meeting_state. Never
 * throws: on failure, falls back to a plain concatenation of raw sources so
 * a prep run can still produce *something* usable rather than nothing.
 *
 * `userNotes` is free text the user typed before clicking "Prepare session"
 * — kept as a distinct parameter rather than folded into `sources` as just
 * another search result, because it should be given priority in the prompt
 * (the user explicitly asked for it), not treated as equal-weight raw
 * context that might get dropped if it seems less relevant than a Jira hit.
 *
 * `cachedRawContent`: pass a Gemini context-cache resource name (from
 * createSharedCache, built from buildRawContextBlock(sources)) to avoid
 * resending the raw sources block — PrepService.ts shares one cache between
 * this and anticipateQA.ts, which both send the identical block. Omit to
 * build and send it inline as before.
 */
export async function synthesizeBrief(
  meetingType: MeetingType,
  sessionName: string | undefined,
  sources: WorkflowSource[],
  userNotes?: string,
  cachedRawContent?: string
): Promise<string> {
  const notes = userNotes?.trim();

  if (sources.length === 0 && !notes) {
    return `No prep context was found for this ${MEETING_TYPE_LABELS[meetingType]} session.`;
  }

  const rawBlock = buildRawContextBlock(sources);
  const notesBlock = notes ? `## Your notes\n\n${notes}` : '';
  const fallback = () => [notesBlock, rawBlock && `## Raw prep context\n\n${rawBlock}`].filter(Boolean).join('\n\n');

  if (!config.geminiApiKey) return fallback();

  try {
    const userNotesInstruction = notes
      ? `\n\nThe user provided the following notes before prep ran — these take priority: make sure the brief addresses them, and weave them in rather than appending them as an afterthought.\nUser's notes: ${notes}`
      : '';
    const header = `${SYNTHESIZE_PROMPT}\n\nMeeting type: ${MEETING_TYPE_LABELS[meetingType]}\nEmphasis for this type: ${TYPE_EMPHASIS[meetingType]}\nSession name: ${sessionName || '(unnamed)'}${userNotesInstruction}`;
    const prompt = cachedRawContent ? header : `${header}\n\nRaw context:\n${rawBlock || '(none)'}`;
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: cachedRawContent ? { cachedContent: cachedRawContent } : undefined,
    });
    logGeminiUsage('synthesizeBrief', response);
    return response.text?.trim() || fallback();
  } catch (err: any) {
    console.error('[prep] brief synthesis failed, falling back to raw context:', err.message);
    return fallback();
  }
}

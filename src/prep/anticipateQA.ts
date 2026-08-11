import { config } from '../config';
import { MEETING_TYPE_LABELS, MeetingType } from './meetingTypes';
import { WorkflowSource } from './workflows/types';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { buildRawContextBlock } from './rawContext';

export interface LikelyQuestion {
  question: string;
  suggestedAnswer: string;
  basedOn: string | null;
}

export interface QuestionToAsk {
  question: string;
  why: string;
}

export interface AnticipatedQA {
  likelyQuestions: LikelyQuestion[];
  questionsToAsk: QuestionToAsk[];
}

const ANTICIPATE_PROMPT = `You are helping someone prepare for a work meeting. Given raw context pulled from several sources (Jira, Confluence, past meeting notes, code activity, etc) for a specific meeting type, produce two things:
1. "likelyQuestions": questions OTHERS might ask THEM in this meeting, each with a concise, concrete draft answer grounded in the context (cite the specific ticket/doc/fact it's based on in "basedOn", or null if it's inferred from general context rather than a specific source).
2. "questionsToAsk": questions THEY could ask others in this meeting to move things forward, each with a one-sentence "why" explaining what it's meant to surface.

Be concrete and specific (ticket keys, names, numbers) over generic. Prefer fewer, sharper questions over a padded list — 2-5 of each is plenty. If the context doesn't support a good question, don't invent a filler one.`;

/**
 * Per-type angle for what's worth anticipating — distinct from
 * synthesizeBrief.ts's TYPE_EMPHASIS (which shapes the brief's structure);
 * this shapes what kinds of questions actually matter for each meeting type.
 */
const TYPE_EMPHASIS: Record<MeetingType, string> = {
  standup: 'Likely questions are status/blocker follow-ups ("is X really on track", "what do you need to unblock Y"). Questions to ask should surface dependencies on others.',
  sprint_planning: 'Likely questions probe estimates and scope ("why does this need N points", "what\'s the risk on this item"). Questions to ask should clarify scope/dependencies before commitment.',
  sprint_review: 'Likely questions come from stakeholders about what shipped, what didn\'t, and timelines. Questions to ask should elicit feedback on what was demoed.',
  retro: 'Likely questions are about why something happened. Questions to ask should be open-ended, prompting the team\'s own perspective rather than presenting conclusions — same framing as the retro brief itself.',
  one_on_one: 'Likely questions are about their progress, blockers, and growth. Questions to ask should be about support needed and career direction, not status reporting.',
  design_dev: 'Likely questions are technical scrutiny of the proposal (edge cases, scale, security, alternatives considered). Questions to ask should probe tradeoffs and risks in the design.',
  generic: 'Keep this light and specific to whatever context is actually present — don\'t force categories that don\'t fit.',
};

const SCHEMA = {
  type: 'object',
  properties: {
    likelyQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          suggestedAnswer: { type: 'string' },
          basedOn: { type: 'string', nullable: true },
        },
        required: ['question', 'suggestedAnswer'],
      },
    },
    questionsToAsk: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['question', 'why'],
      },
    },
  },
  required: ['likelyQuestions', 'questionsToAsk'],
};

/**
 * Independent of synthesizeBrief.ts on purpose — a prompt/schema issue here
 * should never break the editable brief text, and vice versa. Returns null
 * (not an empty object) both when there's nothing to ground it in and on any
 * failure, so the UI can cleanly hide the section rather than show an empty
 * shell — same "skip rather than hallucinate" reasoning as trySource's
 * empty-content handling elsewhere in this feature.
 *
 * `cachedRawContent`: pass a Gemini context-cache resource name (from
 * createSharedCache, built from buildRawContextBlock(sources)) to avoid
 * resending the raw sources block — PrepService.ts shares one cache between
 * this and synthesizeBrief.ts, which both send the identical block. Omit to
 * build and send it inline as before.
 */
export async function anticipateQA(
  meetingType: MeetingType,
  sessionName: string | undefined,
  sources: WorkflowSource[],
  userNotes?: string,
  cachedRawContent?: string
): Promise<AnticipatedQA | null> {
  const notes = userNotes?.trim();
  if (sources.length === 0 && !notes) return null;
  if (!config.geminiApiKey) return null;

  try {
    const rawBlock = buildRawContextBlock(sources);
    const notesInstruction = notes ? `\n\nThe user's own notes for this session: ${notes}` : '';
    const header = `${ANTICIPATE_PROMPT}\n\nMeeting type: ${MEETING_TYPE_LABELS[meetingType]}\nAngle for this type: ${TYPE_EMPHASIS[meetingType]}\nSession name: ${sessionName || '(unnamed)'}${notesInstruction}`;
    const prompt = cachedRawContent ? header : `${header}\n\nRaw context:\n${rawBlock || '(none)'}`;
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        // thinkingBudget: 0 is currently rejected (400) by gemini-flash-latest — 1 is the smallest accepted budget.
        thinkingConfig: { thinkingBudget: 1 },
        ...(cachedRawContent ? { cachedContent: cachedRawContent } : {}),
      },
    });
    logGeminiUsage('anticipateQA', response);
    const parsed = JSON.parse(response.text ?? '{}');
    return {
      likelyQuestions: parsed.likelyQuestions ?? [],
      questionsToAsk: parsed.questionsToAsk ?? [],
    };
  } catch (err: any) {
    console.error('[prep] anticipated Q&A generation failed:', err.message);
    return null;
  }
}

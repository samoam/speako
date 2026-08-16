import { config } from '../../config';
import { getGeminiClient } from '../../gemini/geminiClient';
import { logGeminiUsage } from '../../gemini/logUsage';
import { Task, TaskSource, getTaskById } from '../../storage/taskRepository';
import { getExternalMessageById, ExternalMessage } from '../../storage/externalMessageRepository';
import { DraftGenerateInput, DraftGenerateResult } from '../types';
import { buildRefinementBlock } from '../refinePrompt';
import { gatherReplyContext } from './replyContextGathering';

/** `gatheredContext` is cached on the draft's own content the first time it's gathered (see generateReplyDraft below), so refine/clarify turns reuse it instead of re-querying every tool on every chat message. */
export interface ReplyDraftContent {
  text: string;
  gatheredContext?: string;
}

/** loadSubject for a reply-draft kind — validates the task exists AND belongs to the expected source, so a teams_reply draft can never accidentally attach to an email_message task or vice versa. */
export function loadReplyTaskSubject(expectedSource: TaskSource) {
  return (subjectId: string): Task | undefined => {
    const task = getTaskById(Number(subjectId));
    if (!task || task.source !== expectedSource) return undefined;
    return task;
  };
}

export interface ReplyDraftPromptOptions {
  logLabel: string;
  channelLabel: string;
  toneHint: string;
}

/** Past this many clarifying rounds, the model is told to stop asking and just draft its best guess — prevents an endless back-and-forth from becoming the whole feature's failure mode. */
const MAX_CLARIFYING_QUESTIONS = 3;

const REPLY_ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['draft', 'clarify', 'answer'],
      description:
        '"draft" if you have enough information to write (or rewrite) a good reply now. "clarify" ONLY if a genuine ambiguity needs the user\'s input before you can draft well — a real decision only they can make (e.g. which of two options to go with, a date/number only they know). Do not use "clarify" for stylistic choices like tone or length — just pick a reasonable default. "answer" if the user\'s newest message asks a question about the draft or your reasoning, not a request to change it or new information to incorporate.',
    },
    draftText: {
      type: 'string',
      nullable: true,
      description: 'Your best current reply text — always include this even when action is "clarify" or "answer", as a fallback if clarification never comes.',
    },
    question: { type: 'string', nullable: true, description: 'Only when action is "clarify": ONE focused question for the user.' },
    answer: { type: 'string', nullable: true, description: 'Only when action is "answer": a direct answer to the user\'s question.' },
    note: { type: 'string', nullable: true, description: 'Only when action is "draft": one short sentence describing what changed/why, shown in the refinement history.' },
  },
  required: ['action', 'draftText'],
};

function buildMessageBlock(task: Task, message: ExternalMessage | undefined): string {
  if (!message) return `Original message: ${task.description || task.title}`;
  const from = message.participants.length ? message.participants.join(', ') : 'unknown sender';
  return `Original message (from ${from}, ${message.occurredAt}):\n"""${message.bodyText}"""`;
}

/**
 * Shared generate() body for teams_reply/email_reply. First generation and
 * every refine turn now go through the same "given everything gathered so
 * far, do I draft, ask a clarifying question, or just answer?" decision
 * (REPLY_ENVELOPE_SCHEMA) — previously first generation was a Gemini-free
 * echo of the triage pass's one-line draftReply, with zero context beyond
 * the message itself. Redo turns are unchanged (a short follow-up/
 * correction, not a fresh draft-or-clarify decision).
 */
export async function generateReplyDraft(input: DraftGenerateInput<Task>, opts: ReplyDraftPromptOptions): Promise<DraftGenerateResult> {
  if (input.redo) {
    const priorText = (input.redo.priorContent as ReplyDraftContent | undefined)?.text ?? '';
    if (!config.geminiApiKey) {
      return { mode: 'draft', content: { text: priorText } };
    }
    const prompt = `You previously drafted this ${opts.channelLabel} reply, which was already sent:
"""${priorText}"""

What's happened since:
${input.redo.observed || '(nothing new observed)'}

${input.redo.instruction ? `The user now wants: ${input.redo.instruction}` : 'Draft a short follow-up/correction message given what happened since.'}

Write ONLY the new follow-up message text (${opts.toneHint}) — do not repeat the whole original message, just the correction/follow-up.`;
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiFastModel,
      contents: prompt,
      config: { thinkingConfig: { thinkingBudget: 1 } },
    });
    logGeminiUsage(opts.logLabel, response);
    return { mode: 'draft', content: { text: (response.text || '').trim() || priorText } };
  }

  const priorContent = input.priorContent as ReplyDraftContent | undefined;

  if (!config.geminiApiKey) {
    if (input.instruction) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
    // First generation only: graceful degradation matching the pre-existing
    // convention elsewhere — no context gathering, no clarification, just
    // the triage pass's echo.
    return { mode: 'draft', content: { text: priorContent?.text ?? input.subject.draftReply ?? '' } };
  }

  let message: ExternalMessage | undefined;
  try {
    message = getExternalMessageById(input.subject.externalRef);
  } catch {
    message = undefined;
  }
  // Gathered once per draft, not once per turn — reuse whatever the first
  // generation already fetched rather than re-querying every tool on every
  // chat message (see replyContextGathering.ts's own doc comment).
  const gatheredContext = priorContent?.gatheredContext ?? (await gatherReplyContext(message, input.subject));

  const questionCount = input.history.filter((r) => r.kind === 'question').length;
  const capped = questionCount >= MAX_CLARIFYING_QUESTIONS;

  const parts = [
    `You are drafting a reply to a ${opts.channelLabel} (${opts.toneHint}).`,
    buildMessageBlock(input.subject, message),
    `Context gathered from Speako's connected tools (Jira, Confluence, mem0, RAG, code search, Bitbucket, Jenkins, past Teams/email history, past meetings, web search — some may be empty if nothing relevant was found):\n${gatheredContext}`,
  ];
  if (priorContent?.text || input.history.length) {
    parts.push(buildRefinementBlock(input.history, priorContent?.text ?? ''));
  }
  if (input.instruction) {
    parts.push(`The user's newest message: ${JSON.stringify(input.instruction)}`);
  }
  if (capped) {
    parts.push(
      `You have already asked ${questionCount} clarifying questions in this conversation — that's the limit. You MUST set action to "draft" this turn and use your best judgment for anything still unclear.`
    );
  }

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiFastModel,
    contents: parts.join('\n\n'),
    config: { responseMimeType: 'application/json', responseSchema: REPLY_ENVELOPE_SCHEMA, thinkingConfig: { thinkingBudget: 1 } },
  });
  logGeminiUsage(opts.logLabel, response);
  const parsed = JSON.parse(response.text ?? '{}');

  if (parsed.action === 'answer') {
    return { mode: 'answer', text: parsed.answer || "I don't have anything more specific to add." };
  }
  if (parsed.action === 'clarify' && !capped) {
    return { mode: 'question', text: parsed.question || "Could you clarify what you'd like me to say?" };
  }
  // action === 'draft', or a capped 'clarify' forced into a draft above.
  return {
    mode: 'draft',
    content: { text: parsed.draftText || priorContent?.text || '', gatheredContext },
    note: parsed.note,
  };
}

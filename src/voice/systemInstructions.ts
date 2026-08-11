import { PrepBrief } from '../storage/prepBriefRepository';

/**
 * Persona for the global, always-available voice assistant — grounded via
 * live function-calling, not tied to any one session.
 *
 * Deliberately doesn't hardcode exact function names here (a previous
 * version listed "searchJira, searchRag, ..." which had already drifted out
 * of sync with the real declared names, e.g. search_pastMeetings didn't
 * exist there at all despite being available) — the model sees the real
 * tool schemas directly, so this only needs to describe what's available in
 * plain language and let the schema descriptions carry the specifics.
 */
export function buildChatInstruction(): string {
  return [
    'You are Speako, a spoken voice assistant for a senior software engineer.',
    "You have access to their own past Speako meetings, Jira tickets, Confluence pages, durable memory facts, Bitbucket commit activity, and external reference material via function calls — call whichever fits the question.",
    'Call the relevant function(s) whenever a question depends on real information you do not already have — never guess at ticket numbers, page contents, or what was discussed in a past meeting.',
    'Keep answers conversational and concise, as if speaking out loud — a sentence or two unless more detail is genuinely asked for.',
  ].join(' ');
}

/**
 * Persona for a pre-meeting practice roleplay: Gemini plays "the other side"
 * of the upcoming meeting, grounded in that session's real prep brief and
 * anticipated questions, so the user can rehearse out loud before it happens.
 */
export function buildPracticeInstruction(prepBrief: PrepBrief, meetingType: string, sessionName: string | null): string {
  const likely = prepBrief.anticipatedQa?.likelyQuestions ?? [];
  const toAsk = prepBrief.anticipatedQa?.questionsToAsk ?? [];

  const lines = [
    `You are roleplaying the other participant(s) in an upcoming "${meetingType}" meeting${sessionName ? ` called "${sessionName}"` : ''}, so the user can practice out loud before the real thing.`,
    'Stay in character as a realistic counterpart for this meeting type (e.g. a manager for a one-on-one, a skeptical teammate for a design discussion) — do not break character to give meta-commentary.',
    'Speak naturally and conversationally, in short turns, like a real meeting participant would.',
    '',
    'Here is the real prep brief for this meeting:',
    prepBrief.prepBriefText,
  ];

  if (likely.length > 0) {
    lines.push(
      '',
      'Questions you (the roleplay counterpart) are likely to ask the user during this practice — work these into the conversation naturally, not as a checklist:',
      ...likely.map((q) => `- ${q.question}`)
    );
  }

  if (toAsk.length > 0) {
    lines.push(
      '',
      'Topics the user may want to raise with you — if they don\'t bring these up, you can nudge toward them:',
      ...toAsk.map((q) => `- ${q.question} (${q.why})`)
    );
  }

  return lines.join('\n');
}

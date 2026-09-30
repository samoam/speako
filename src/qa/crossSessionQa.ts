import { retrieve } from '../rag/rag';
import { generateText } from '../ai/aiRouter';

export interface CrossSessionAnswer {
  answerText: string;
  sourcesUsed: string[];
}

/**
 * "Ask across all my meetings" — same shape as liveQa.ts's answerLiveQuestion
 * but scoped to the whole RAG corpus instead of one session, since there's no
 * "current session" here to ground against or exclude. Deliberately limited
 * to the meeting corpus only (no Bitbucket/Jira/Confluence fan-out): those
 * integrations are gated per-session via activeTools, and a cross-session
 * question has no session to check that against.
 */
export async function answerAcrossAllMeetings(question: string): Promise<CrossSessionAnswer> {
  const ragResult = await retrieve(question);

  const sourcesUsed = ragResult.suppressed ? [] : ragResult.chunks.map((c) => c.sessionName || 'a past session');
  const contextBlock = ragResult.suppressed
    ? '(nothing in past meetings clears the relevance threshold for this question)'
    : ragResult.chunks.map((c) => `- (${c.sessionName || 'a past session'}) ${c.text}`).join('\n');

  const prompt = `You are answering a question about the user's past meetings, using retrieved excerpts from across all of them. If the retrieved context doesn't cover the question, say so plainly rather than guessing.

Question: ${question}

Retrieved context from past meetings:
${contextBlock}`;

  const answerText = await generateText('knowledgeQa', 'answerAcrossAllMeetings', prompt);
  return { answerText, sourcesUsed: [...new Set(sourcesUsed)] };
}

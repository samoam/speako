import { config } from '../config';
import { retrieve } from '../rag/rag';
import { searchBitbucketServer, isBitbucketConfigured } from '../integrations/bitbucketServer';
import { searchJira, isJiraConfigured } from '../integrations/jiraMcp';
import { searchConfluence, isConfluenceConfigured } from '../integrations/confluenceMcp';
import { looksCodeRelated } from '../router';
import { toPlainText } from '../transcriptFormat';
import { TranscriptSegment } from '../types';
import { getMeetingStateSnapshot } from '../state/meetingState';
import { getGeminiClient } from '../gemini/geminiClient';

export interface LiveQaAnswer {
  answerText: string;
  sourcesUsed: string[];
}

/**
 * Answers a question asked during (or about) a session, grounded in the
 * personal RAG corpus, Bitbucket/Jira/Confluence (whichever are configured —
 * Bitbucket only when the question looks code-related, same router heuristic
 * as fact-checking; Jira/Confluence unconditionally since they cover a much
 * wider range of topics), and the session's own transcript so far (spec §5.2
 * point 3 — the answer should account for what's currently being discussed,
 * not just the question in isolation).
 */
export async function answerLiveQuestion(sessionId: string, question: string, sessionSegments: TranscriptSegment[]): Promise<LiveQaAnswer> {
  const sourcesUsed: string[] = [];
  const contextParts: string[] = [];

  const ragResult = await retrieve(question, sessionId);
  if (!ragResult.suppressed) {
    sourcesUsed.push('Past meetings');
    contextParts.push(
      'Past meetings:\n' + ragResult.chunks.map((c) => `- (${c.sessionName || 'a past session'}) ${c.text}`).join('\n')
    );
  }

  if (isBitbucketConfigured() && looksCodeRelated(question)) {
    try {
      const matches = await searchBitbucketServer(question);
      if (matches.length > 0) {
        sourcesUsed.push('Bitbucket');
        contextParts.push('Bitbucket:\n' + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
      }
    } catch (err: any) {
      console.error('[live-qa] Bitbucket search failed:', err.message);
    }
  }

  if (isJiraConfigured()) {
    try {
      const matches = await searchJira(question);
      if (matches.length > 0) {
        sourcesUsed.push('Jira');
        contextParts.push('Jira:\n' + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
      }
    } catch (err: any) {
      console.error('[live-qa] Jira search failed:', err.message);
    }
  }

  if (isConfluenceConfigured()) {
    try {
      const matches = await searchConfluence(question);
      if (matches.length > 0) {
        sourcesUsed.push('Confluence');
        contextParts.push('Confluence:\n' + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
      }
    } catch (err: any) {
      console.error('[live-qa] Confluence search failed:', err.message);
    }
  }

  // Improvements Phase §2: the rolling summary + open-items registry give a
  // compact structured view of the meeting alongside the raw transcript below
  // — useful once a meeting runs long enough that the full transcript alone
  // is unwieldy, and the open items make "is this already being tracked?"
  // explicit rather than something the model has to infer from raw text.
  const state = getMeetingStateSnapshot(sessionId);
  const openItemsBlock = state.openItems.length
    ? state.openItems.map((i) => `- [${i.category}] ${i.description}`).join('\n')
    : '(none tracked yet)';

  const transcriptContext = toPlainText(sessionSegments);
  const prompt = `You are answering a question asked live during a meeting. Use the retrieved context and the meeting transcript so far to answer concisely and accurately. If there isn't enough information, say so plainly rather than guessing.

Question: ${question}

Meeting summary so far:
${state.rollingSummary || '(nothing yet)'}

Open items tracked this meeting:
${openItemsBlock}

Meeting transcript so far:
${transcriptContext || '(nothing said yet)'}

Retrieved context:
${contextParts.join('\n\n') || '(none found)'}`;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: prompt,
  });

  return { answerText: (response.text ?? '').trim(), sourcesUsed };
}

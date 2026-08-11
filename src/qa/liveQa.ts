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
import { logGeminiUsage } from '../gemini/logUsage';

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

  // These four lookups are independent — run them concurrently (this is on
  // the interactive live-QA path, so their latencies would otherwise stack)
  // and fold the results back in a fixed order below, so contextParts stays
  // deterministic regardless of which one resolves first.
  const bitbucketWanted = isBitbucketConfigured() && looksCodeRelated(question);
  const [ragResult, bitbucketMatches, jiraMatches, confluenceMatches] = await Promise.all([
    retrieve(question, sessionId),
    bitbucketWanted
      ? searchBitbucketServer(question).catch((err: any) => {
          console.error('[live-qa] Bitbucket search failed:', err.message);
          return null;
        })
      : Promise.resolve(null),
    isJiraConfigured()
      ? searchJira(question).catch((err: any) => {
          console.error('[live-qa] Jira search failed:', err.message);
          return null;
        })
      : Promise.resolve(null),
    isConfluenceConfigured()
      ? searchConfluence(question).catch((err: any) => {
          console.error('[live-qa] Confluence search failed:', err.message);
          return null;
        })
      : Promise.resolve(null),
  ]);

  if (!ragResult.suppressed) {
    sourcesUsed.push('Past meetings');
    contextParts.push(
      'Past meetings:\n' + ragResult.chunks.map((c) => `- (${c.sessionName || 'a past session'}) ${c.text}`).join('\n')
    );
  }

  for (const [label, matches] of [
    ['Bitbucket', bitbucketMatches],
    ['Jira', jiraMatches],
    ['Confluence', confluenceMatches],
  ] as const) {
    if (matches && matches.length > 0) {
      sourcesUsed.push(label);
      contextParts.push(`${label}:\n` + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
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

  // Only the most recent segments are sent inline — the rolling summary +
  // open items above already carry everything earlier, so resending the
  // full transcript on every question would grow the prompt (and cost)
  // linearly with meeting length for no benefit.
  const recentSegments = sessionSegments.slice(-config.liveQaTranscriptWindowSegments);
  const transcriptContext = toPlainText(recentSegments);
  const prompt = `You are answering a question asked live during a meeting. Use the retrieved context, the meeting summary, and the most recent transcript to answer concisely and accurately. If there isn't enough information, say so plainly rather than guessing.

Question: ${question}

Meeting summary so far:
${state.rollingSummary || '(nothing yet)'}

Open items tracked this meeting:
${openItemsBlock}

Most recent meeting transcript (earlier context is captured in the summary above):
${transcriptContext || '(nothing said yet)'}

Retrieved context:
${contextParts.join('\n\n') || '(none found)'}`;

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: prompt,
  });
  logGeminiUsage('answerLiveQuestion', response);

  return { answerText: (response.text ?? '').trim(), sourcesUsed };
}

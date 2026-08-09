import { config } from '../config';
import { searchBitbucketServer, isBitbucketConfigured } from '../integrations/bitbucketServer';
import { searchJira, isJiraConfigured } from '../integrations/jiraMcp';
import { searchConfluence, isConfluenceConfigured } from '../integrations/confluenceMcp';
import { webFactCheckClaim, isWebFactCheckConfigured } from './webFactCheck';
import { looksCodeRelated } from '../router';
import { getMeetingStateSnapshot } from '../state/meetingState';
import { getGeminiClient } from '../gemini/geminiClient';
import { getSession } from '../storage/segmentRepository';
import { isToolActive } from '../tools/activeTools';

const FACT_CHECK_PROMPT = `You are checking a spoken claim against ground truth retrieved from Bitbucket (code/commits), Jira (tickets), and/or Confluence (docs). The CONTEXT below is organized into sections labeled by source.
Compare the CLAIM to the CONTEXT and judge whether it is correct.
- "match": the claim is clearly correct per the context.
- "conflict": the claim clearly contradicts the context.
- "insufficient": the context doesn't contain enough to judge either way.
Be conservative — only answer match/conflict when the context clearly supports it; default to insufficient.
"groundTruth" should be the specific fact from the context that supports your answer, or null if insufficient.
"source" should be the exact label (e.g. "bitbucket", "jira", "confluence") of the ONE section that actually supports your verdict, or null if insufficient.`;

const FACT_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['match', 'conflict', 'insufficient'] },
    groundTruth: { type: 'string', nullable: true },
    source: { type: 'string', nullable: true },
  },
  required: ['result'],
};

export interface FactCheckOutcome {
  result: 'match' | 'conflict' | 'insufficient';
  groundTruth: string | null;
  sourceQueried: string;
}

export function isAnyFactCheckSourceConfigured(): boolean {
  return isBitbucketConfigured() || isJiraConfigured() || isConfluenceConfigured() || isWebFactCheckConfigured();
}

/**
 * Runs the fact-check pipeline (spec §4.2) for a claim already flagged by
 * trigger detection's factual_claim category, checking it against whichever
 * of Bitbucket/Jira/Confluence are configured. Bitbucket is only queried when
 * the claim looks code-related (the router step — searching commit history
 * for a claim about, say, a meeting schedule would just add noise); Jira and
 * Confluence are queried unconditionally since tickets/docs cover a much
 * broader range of topics than code does. If none of those three internal
 * sources turned up anything usable — either because the claim isn't about
 * this team's code/tickets/docs at all, or because it is but nothing matched
 * — falls back to a web search (Gemini's Google Search grounding) rather
 * than giving up. Returns null only if nothing was even attempted (nothing
 * internal applicable AND no Gemini key for the web fallback). `sessionId` is
 * used to pull in this meeting's rolling summary (Improvements Phase §2) so
 * the same conflict restated in different words later in the meeting isn't
 * re-flagged as if it were new information.
 */
export async function factCheckClaim(claimText: string, sessionId: string): Promise<FactCheckOutcome | null> {
  // Sources actually attempted (a search call was made, regardless of whether
  // it found anything) vs. sources that contributed matches to the context —
  // kept distinct so "queried but found nothing" (result: insufficient, still
  // recorded/visible) isn't confused with "nothing was applicable to query at
  // all" (returns null — no row is recorded, since there's nothing to show).
  const sourcesAttempted: string[] = [];
  const contextParts: string[] = [];
  // Which of those sourcesAttempted actually contributed content to contextParts
  // (vs. attempted-but-empty) — used to validate/fall back on whatever source
  // name the model reports it relied on, so the final result only cites the
  // source(s) that actually mattered, not everything that happened to be tried.
  const contextSources: string[] = [];
  const activeTools = getSession(sessionId)?.activeTools ?? null;

  if (isBitbucketConfigured() && isToolActive(activeTools, 'bitbucket') && looksCodeRelated(claimText)) {
    try {
      const matches = await searchBitbucketServer(claimText);
      sourcesAttempted.push('bitbucket');
      if (matches.length > 0) {
        contextParts.push('bitbucket:\n' + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
        contextSources.push('bitbucket');
      }
    } catch (err: any) {
      console.error('[factcheck] Bitbucket search failed:', err.message);
    }
  }

  if (isJiraConfigured() && isToolActive(activeTools, 'jira')) {
    try {
      const matches = await searchJira(claimText);
      sourcesAttempted.push('jira');
      if (matches.length > 0) {
        contextParts.push('jira:\n' + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
        contextSources.push('jira');
      }
    } catch (err: any) {
      console.error('[factcheck] Jira search failed:', err.message);
    }
  }

  if (isConfluenceConfigured() && isToolActive(activeTools, 'confluence')) {
    try {
      const matches = await searchConfluence(claimText);
      sourcesAttempted.push('confluence');
      if (matches.length > 0) {
        contextParts.push('confluence:\n' + matches.map((m) => `- ${m.path}: ${m.snippet}`).join('\n'));
        contextSources.push('confluence');
      }
    } catch (err: any) {
      console.error('[factcheck] Confluence search failed:', err.message);
    }
  }

  // Internal-context judgment first, if there's anything to judge — but note
  // Confluence's search in particular ALWAYS returns its "closest" results
  // even for a completely unrelated query (confirmed: a claim about the
  // Eiffel Tower still got back Confluence pages about VPNs and bug-ticket
  // conventions) — so contextParts.length > 0 does not mean anything
  // relevant was actually found. Only trust a confident match/conflict here;
  // "insufficient" still falls through to the web fallback below rather than
  // being treated as final.
  let internalResult: 'match' | 'conflict' | 'insufficient' | null = null;
  let internalGroundTruth: string | null = null;
  if (contextParts.length > 0) {
    const meetingSummary = getMeetingStateSnapshot(sessionId).rollingSummary;
    const response = await getGeminiClient().models.generateContent({
      model: config.geminiModel,
      contents: `${FACT_CHECK_PROMPT}\n\nMEETING SO FAR (for context only — if this claim/conflict was already established and discussed earlier in the meeting, note that in groundTruth rather than treating it as a fresh discovery):\n${meetingSummary || '(nothing yet)'}\n\nCLAIM: "${claimText}"\n\nCONTEXT:\n${contextParts.join('\n\n')}`,
      config: { responseMimeType: 'application/json', responseSchema: FACT_CHECK_SCHEMA },
    });
    const parsed = JSON.parse(response.text ?? '{}');
    const result: 'match' | 'conflict' | 'insufficient' = parsed.result ?? 'insufficient';
    internalResult = result;
    internalGroundTruth = parsed.groundTruth ?? null;
    if (result !== 'insufficient') {
      // Prefer the specific source the model says it relied on; only fall
      // back to listing every source that had (possibly irrelevant) content
      // if the model's answer doesn't match one we actually gave it.
      const citedSource = contextSources.includes(parsed.source) ? parsed.source : contextSources.join(', ');
      return { result, groundTruth: internalGroundTruth, sourceQueried: citedSource };
    }
  }

  if (isWebFactCheckConfigured() && isToolActive(activeTools, 'webSearch')) {
    try {
      const webOutcome = await webFactCheckClaim(claimText);
      if (webOutcome) {
        if (webOutcome.result !== 'insufficient' || internalResult === null) {
          return {
            result: webOutcome.result,
            groundTruth: webOutcome.groundTruth,
            sourceQueried: webOutcome.citations.length > 0 ? `web (${webOutcome.citations.join(', ')})` : 'web',
          };
        }
        sourcesAttempted.push('web');
      }
    } catch (err: any) {
      console.error('[factcheck] Web search failed:', err.message);
    }
  }

  if (sourcesAttempted.length === 0) return null;
  return { result: internalResult ?? 'insufficient', groundTruth: internalGroundTruth, sourceQueried: sourcesAttempted.join(', ') };
}

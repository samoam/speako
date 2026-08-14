import { retrieve } from '../rag/rag';
import { gatherSources, gatherToolSources, trySource, WorkflowSource } from '../prep/workflows/types';

/**
 * Gathers grounding material for a subject-driven Audio Overview using the
 * same tool-fanout machinery the prep-brief workflows use (gatherToolSources/
 * trySource, src/prep/workflows/types.ts) — gated per-session by activeTools
 * exactly like every prep workflow already is, instead of the RAG-only
 * lookup this feature used before. Queries every integration once (closest
 * existing precedent: designDev.ts's "query everything" shape), plus past
 * meetings via the same retrieve() call crossSessionQa.ts already makes.
 */
export async function gatherAudioOverviewContext(
  sessionId: string,
  subject: string,
  activeTools: string[] | null
): Promise<string> {
  const ctx = { activeTools };

  const sources = [
    ...gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_context', query: subject, limit: 5 },
      { tool: 'confluence', name: 'confluence_context', query: subject, limit: 5 },
      { tool: 'bitbucket', name: 'bitbucket_context', query: subject, limit: 5 },
      { tool: 'ragCloud', name: 'myrag_context', query: subject, limit: 5 },
      { tool: 'localCodebase', name: 'local_codebase_context', query: subject, limit: 5 },
      { tool: 'email', name: 'email_context', query: subject, limit: 5 },
      { tool: 'teams', name: 'teams_context', query: subject, limit: 5 },
      { tool: 'mem0', name: 'mem0_context', query: subject, limit: 5 },
      { tool: 'webSearch', name: 'web_context', query: subject },
    ]),
    trySource('past_meetings', async () => {
      const result = await retrieve(subject, sessionId);
      return result.suppressed ? '' : result.chunks.map((c) => `(${c.sessionName || 'a past session'}) ${c.text}`).join('\n');
    }),
  ];

  const { sources: gathered } = await gatherSources(sources);
  return formatSources(gathered);
}

function formatSources(sources: WorkflowSource[]): string {
  if (!sources.length) return '(nothing relevant found across configured tools or past meetings)';
  return sources.map((s) => `### ${s.name}\n${s.content}`).join('\n\n');
}

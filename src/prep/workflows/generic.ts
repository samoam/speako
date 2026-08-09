import { retrieve } from '../../rag/rag';
import { looksCodeRelated } from '../../router';
import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, searchTopic, trySource } from './types';

/**
 * §4.6 Fallback/Generic: lighter combined Jira + Confluence + personal-RAG
 * keyword search against the session name + user notes, no type-specific
 * structuring. Bitbucket is only queried when the topic looks code-related
 * (reusing the same heuristic factcheck.ts uses) rather than unconditionally.
 */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  const query = searchTopic(ctx, 'this meeting');

  const sources = [
    ...gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_keyword_search', query, limit: 5 },
      { tool: 'confluence', name: 'confluence_keyword_search', query, limit: 3 },
      { tool: 'email', name: 'email_context', query, limit: 5 },
      { tool: 'teams', name: 'teams_context', query, limit: 5 },
    ]),
    trySource('personal_rag', async () => {
      const result = await retrieve(query, ctx.sessionId);
      return result.chunks.map((c) => c.text).join('\n');
    }),
  ];

  if (looksCodeRelated(query)) {
    sources.push(...gatherToolSources(ctx, [{ tool: 'bitbucket', name: 'bitbucket_keyword_search', query, limit: 5 }]));
  }

  return gatherSources(sources);
}

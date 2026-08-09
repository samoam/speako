import { getOpenActionItemsByOwner } from '../../storage/summaryRepository';
import { retrieve } from '../../rag/rag';
import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, previousSessionNotes, trySource } from './types';

/**
 * §4.4 One-on-One: durable mem0 facts about this person + personal-RAG hits
 * from past 1:1s with them + their open action items + their recent Jira
 * activity. There's no normalized "person" entity in Speako's data model —
 * the session name (e.g. "1:1 with Sarah") is used as-is as the query/filter
 * term across all four sources, same simplification everywhere here.
 */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  const personQuery = ctx.sessionName || 'this person';

  return gatherSources([
    ...gatherToolSources(ctx, [
      { tool: 'mem0', name: 'mem0_facts', query: personQuery, limit: 5 },
      { tool: 'jira', name: 'jira_their_activity', query: `assigned to OR touched by ${personQuery}`, limit: 5 },
      { tool: 'email', name: 'email_context', query: personQuery, limit: 5 },
      { tool: 'teams', name: 'teams_context', query: personQuery, limit: 5 },
    ]),
    trySource('past_1on1s', async () => {
      const result = await retrieve(personQuery, ctx.sessionId);
      return result.chunks.map((c) => c.text).join('\n');
    }),
    trySource('open_action_items', async () => {
      const items = getOpenActionItemsByOwner(personQuery);
      return items.map((i) => `- ${i.description}`).join('\n');
    }),
    trySource('previous_1on1', () => previousSessionNotes(ctx.previousSession)),
  ]);
}

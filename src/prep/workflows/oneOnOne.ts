import { getOpenActionItemsByOwner } from '../../storage/summaryRepository';
import { retrieve } from '../../rag/rag';
import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, previousSessionNotes, searchTopic, trySource } from './types';

/**
 * §4.4 One-on-One: durable mem0 facts about this person + personal-RAG hits
 * from past 1:1s with them + their open action items + their recent Jira
 * activity. There's no normalized "person" entity in Speako's data model —
 * the session name (e.g. "1:1 with Sarah") is the primary identifying term,
 * combined with any user notes via searchTopic() so something typed only in
 * notes (e.g. "ask about the promotion timeline") also reaches the Jira/
 * email/Teams queries below, not just the final synthesis prompt.
 */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  const personQuery = searchTopic(ctx, 'this person');
  // getOpenActionItemsByOwner does a plain substring match against the
  // stored `owner` name (e.g. "Sarah") — unlike the semantic/keyword
  // sources below, it must stay the bare person name, not personQuery with
  // notes appended, or it'll never match anything once notes are present.
  const ownerName = ctx.sessionName?.trim() || 'this person';

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
      const items = getOpenActionItemsByOwner(ownerName);
      return items.map((i) => `- ${i.description}`).join('\n');
    }),
    trySource('previous_1on1', () => previousSessionNotes(ctx.previousSession)),
  ]);
}

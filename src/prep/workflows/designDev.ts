import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, searchTopic } from './types';

/**
 * §4.5 Design/Dev Discussion: Confluence design docs, related Jira tickets,
 * recent code activity, MyRAG for one-off external references, and web
 * search as a last resort for external tech not covered internally.
 */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  const topic = searchTopic(ctx, 'this discussion');

  return gatherSources(
    gatherToolSources(ctx, [
      { tool: 'confluence', name: 'confluence_design_docs', query: topic, limit: 5 },
      { tool: 'jira', name: 'jira_related_tickets', query: topic, limit: 5 },
      { tool: 'bitbucket', name: 'bitbucket_recent_activity', query: topic, limit: 5 },
      { tool: 'ragCloud', name: 'myrag_external_refs', query: topic, limit: 5 },
      { tool: 'localCodebase', name: 'local_codebase', query: topic, limit: 5 },
      { tool: 'email', name: 'email_context', query: topic, limit: 5 },
      { tool: 'teams', name: 'teams_context', query: topic, limit: 5 },
      { tool: 'webSearch', name: 'web_context', query: topic },
    ])
  );
}

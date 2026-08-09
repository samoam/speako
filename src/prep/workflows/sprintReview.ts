import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources } from './types';

/** §4.2 Sprint Review: sprint tickets by status, sprint-goal/release-notes doc, recent commits for demo-relevant activity, plus any stakeholder email threads. */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  const topic = ctx.sessionName || 'this sprint';

  return gatherSources(
    gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_sprint_tickets', query: 'current sprint OR just closed sprint', limit: 10 },
      { tool: 'confluence', name: 'confluence_sprint_goal', query: `${ctx.sessionName || ''} sprint goal release notes`, limit: 3 },
      { tool: 'bitbucket', name: 'bitbucket_recent_commits', query: 'recent changes', limit: 5 },
      { tool: 'email', name: 'email_context', query: topic, limit: 5 },
    ])
  );
}

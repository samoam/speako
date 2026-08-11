import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, previousSessionNotes, trySource } from './types';

/**
 * §4.3 Sprint Planning: backlog, carryover tickets, historical velocity, and
 * an optional codebase cross-reference — catches backlog items that may
 * already be partially started or completed outside of Jira tracking.
 */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  return gatherSources([
    ...gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_backlog', query: 'backlog prioritized', limit: 10 },
      { tool: 'jira', name: 'jira_carryover', query: 'carried over from previous sprint not started', limit: 8 },
      { tool: 'confluence', name: 'confluence_velocity', query: 'sprint velocity tracking', limit: 3 },
      { tool: 'bitbucket', name: 'bitbucket_recent_activity', query: 'recent changes', limit: 5 },
      { tool: 'bitbucketReviews', name: 'bitbucket_my_pr_activity', query: '', limit: 5 },
    ]),
    trySource('previous_planning', () => previousSessionNotes(ctx.previousSession)),
  ]);
}

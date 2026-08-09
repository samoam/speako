import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, previousSessionNotes, trySource } from './types';

/** §4.1 Standup: recent Jira activity + blockers, the sprint goal to frame updates against, plus the prior standup's notes. */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  return gatherSources([
    ...gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_recent_activity', query: 'updated in the last 24 hours assigned to me', limit: 8 },
      { tool: 'jira', name: 'jira_blockers', query: 'blocked OR overdue', limit: 8 },
      { tool: 'confluence', name: 'confluence_sprint_goal', query: 'sprint goal team working agreement', limit: 2 },
    ]),
    trySource('previous_standup', () => previousSessionNotes(ctx.previousSession)),
  ]);
}

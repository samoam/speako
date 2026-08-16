import { getAtlassianClient as getClient } from './atlassianMcp';
import { isJiraConfigured, getJiraIssueDetail } from './jiraMcp';
import { LifecycleState, STATE_ALIASES, toLifecycleState, normalizeStatusName } from '../dev/lifecycle';

/** Same small helper as jiraMcp.ts's private extractResultText — duplicated rather than exported/shared across two files for a 5-line function. */
function extractResultText(result: any): string {
  if (typeof result?.structuredContent?.result === 'string') return result.structuredContent.result;
  const textBlock = result?.content?.find((c: any) => c.type === 'text');
  if (textBlock?.text) return textBlock.text;
  return '';
}

export interface JiraAvailableTransition {
  id: string;
  name: string;
  toStatusName: string;
}

/**
 * Calls mcp-atlassian's jira_get_transitions — never called anywhere in
 * src/ before this. Param/response shape follows the same snake_case
 * convention already confirmed live for jira_create_issue/jira_update_issue
 * (jiraMcp.ts), but this specific tool has NOT itself been confirmed live
 * against a real Jira instance (none configured in this dev environment) —
 * verify the response shape against one real ticket in each lifecycle state
 * before relying on this in production (see the "confirmed live" convention
 * elsewhere in this codebase, e.g. claudeCodeCli.ts).
 */
async function getAvailableTransitions(issueKey: string): Promise<JiraAvailableTransition[]> {
  if (!isJiraConfigured()) throw new Error('Jira is not configured — see NOTES.md.');
  const result = await getClient().callTool('jira_get_transitions', { issue_key: issueKey });
  const text = extractResultText(result);
  if (result?.isError) {
    throw new Error(text || `Failed to fetch available transitions for ${issueKey}.`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse Jira's available transitions for ${issueKey}: ${text.slice(0, 300)}`);
  }
  const list: any[] = Array.isArray(parsed) ? parsed : (parsed.transitions ?? []);
  return list.map((t) => ({
    id: String(t.id),
    name: t.name ?? t.transition_name ?? '',
    toStatusName: t.to?.name ?? t.to_status ?? t.name ?? '',
  }));
}

/** Thrown when the ticket's real workflow simply doesn't offer the target state as an option right now — lists what it DOES offer, so the UI can say "Jira offers: X, Y — none of them is Z" rather than silently doing nothing. */
export class JiraTransitionUnavailableError extends Error {}

/**
 * Resolves a SEMANTIC target lifecycle state to this ticket's real,
 * per-workflow transition id. Match order (first hit wins — deliberately
 * strict, a miss must fail loudly rather than guess at the wrong transition):
 *   1. transition.toStatusName normalizes to the target state's canonical name
 *   2. transition.toStatusName matches one of STATE_ALIASES[target]
 *   3. transition.name (the action label — some workflows name the ACTION,
 *      not the destination, e.g. "Start Progress" rather than "In Progress")
 *      matches the target or its aliases
 */
export async function resolveTransition(issueKey: string, target: LifecycleState): Promise<JiraAvailableTransition> {
  const transitions = await getAvailableTransitions(issueKey);
  const candidateNames = [target, ...STATE_ALIASES[target]].map(normalizeStatusName);

  for (const t of transitions) {
    if (candidateNames.includes(normalizeStatusName(t.toStatusName))) return t;
  }
  for (const t of transitions) {
    if (candidateNames.includes(normalizeStatusName(t.name))) return t;
  }
  throw new JiraTransitionUnavailableError(
    `Jira offers: ${transitions.map((t) => t.name).filter(Boolean).join(', ') || '(no transitions available right now)'} — none of them is "${target}".`
  );
}

/** Real write — uses the resolved transition id via jira_transition_issue, deliberately NOT jiraMcp.ts's updateJiraIssue (whose `transition` field is a free-text status name with zero validation against what's actually available on this ticket's workflow). */
export async function transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void> {
  if (!isJiraConfigured()) throw new Error('Jira is not configured — see NOTES.md.');
  const result = await getClient().callTool('jira_transition_issue', {
    issue_key: issueKey,
    transition_id: transitionId,
    ...(comment ? { comment } : {}),
  });
  const text = extractResultText(result);
  if (result?.isError) {
    throw new Error(text || `Failed to transition ${issueKey}.`);
  }
}

/** Reads the ticket's current status and maps it onto our six lifecycle states. Null if it's in a status outside our graph (e.g. a bespoke project status) — callers must propose nothing in that case, never guess. */
export async function getCurrentLifecycleState(issueKey: string): Promise<LifecycleState | null> {
  const detail = await getJiraIssueDetail(issueKey);
  if (!detail) throw new Error(`Jira issue ${issueKey} was not found.`);
  return toLifecycleState(detail.status);
}

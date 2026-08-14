import { config } from '../config';
import { getAtlassianClient as getClient } from './atlassianMcp';

export interface JiraMatch {
  path: string;
  snippet: string;
}

export function isJiraConfigured(): boolean {
  return !!(config.jiraUrl && config.jiraPersonalToken);
}

/** Extracts the text result from an MCP tool call, regardless of whether it comes back as structuredContent or a content[].text block. */
function extractResultText(result: any): string {
  if (typeof result?.structuredContent?.result === 'string') return result.structuredContent.result;
  const textBlock = result?.content?.find((c: any) => c.type === 'text');
  if (textBlock?.text) return textBlock.text;
  return '';
}

/** Matches Jira issue keys like "ITIC-9652" or "ETICK-8613" directly named in text. */
function extractIssueKeys(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
  return [...new Set(matches)];
}

/**
 * Looks up a specific issue by key via the read-only `jira_get_issue` tool —
 * this is the correct way to check a claim that names a ticket directly
 * (e.g. "ITIC-9652 is closed"). A generic `text ~ "<sentence>"` JQL search
 * does NOT find issues by key — full-text search only matches words that
 * literally appear in an issue's summary/description, so a claim quoting a
 * key plus surrounding commentary reliably returns zero hits even when the
 * ticket exists (confirmed during testing). When the issue doesn't exist,
 * the tool call itself is informative (proves the claim's premise wrong), so
 * that error text is surfaced as a match rather than silently discarded.
 */
async function getJiraIssue(issueKey: string): Promise<JiraMatch | null> {
  const result = await getClient().callTool('jira_get_issue', {
    issue_key: issueKey,
    fields: 'summary,status,assignee,updated,issuetype',
  });

  const text = extractResultText(result);
  if (!text) return null;

  if (result?.isError) {
    return { path: issueKey, snippet: text.slice(0, 500) };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { path: issueKey, snippet: text.slice(0, 1500) };
  }

  return {
    path: parsed.key ?? issueKey,
    snippet: `${parsed.fields?.summary ?? parsed.summary ?? ''} [${parsed.fields?.status?.name ?? parsed.status?.name ?? parsed.status ?? ''}]`,
  };
}

/**
 * Searches Jira issues via the `mcp-atlassian` MCP server's read-only tools
 * — never call any of this server's write tools (jira_create_issue,
 * jira_update_issue, etc.). Issue keys named directly in the query (e.g.
 * "ITIC-9652") are looked up via `jira_get_issue`; the remaining free text is
 * also run through `jira_search`'s `text ~ "..."` JQL clause (full-text
 * search across summary/description) so non-key-specific claims/questions
 * still get a chance to match.
 */
export async function searchJira(query: string, limit = 5): Promise<JiraMatch[]> {
  if (!isJiraConfigured()) {
    throw new Error('Jira is not configured — see NOTES.md.');
  }

  const matches: JiraMatch[] = [];

  for (const key of extractIssueKeys(query)) {
    try {
      const match = await getJiraIssue(key);
      if (match) matches.push(match);
    } catch (err: any) {
      console.error(`[jira] get_issue failed for ${key}:`, err.message);
    }
    if (matches.length >= limit) return matches.slice(0, limit);
  }

  const jql = `text ~ ${JSON.stringify(query)} ORDER BY updated DESC`;
  const result = await getClient().callTool('jira_search', {
    jql,
    limit,
    fields: 'summary,status,assignee,updated,issuetype',
  });

  const text = extractResultText(result);
  if (!text) return matches;

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (!result?.isError) matches.push({ path: 'jira', snippet: text.slice(0, 1500) });
    return matches.slice(0, limit);
  }

  const issues = Array.isArray(parsed) ? parsed : (parsed.issues ?? parsed.values ?? []);
  for (const issue of issues) {
    matches.push({
      path: issue.key ?? 'jira',
      snippet: `${issue.fields?.summary ?? issue.summary ?? ''} [${issue.fields?.status?.name ?? issue.status?.name ?? issue.status ?? ''}]`,
    });
    if (matches.length >= limit) break;
  }

  return matches.slice(0, limit);
}

export interface JiraTaskMatch {
  key: string;
  summary: string;
  url: string;
  priorityName: string | null;
  statusName: string | null;
  dueDate: string | null;
  updated: string | null;
}

/**
 * Issues currently assigned to the authenticated Jira account, unresolved,
 * ordered by Jira's own priority then recency — the "what's on my plate"
 * source for the orchestrator's tasks board (src/orchestrator/taskSync.ts).
 * `currentUser()` resolves server-side against the same token searchJira
 * already authenticates with — no separate username config needed.
 * Response shape (`jira_search`'s normalized JSON, verified directly
 * against a real `mcp-atlassian` call, not assumed): a flat
 * `{key, summary, browse_url, status: {name}, priority: {name}, updated}`
 * object per issue — notably NOT the raw Jira REST API's nested
 * `fields: {...}` shape searchJira/getJiraIssue parse elsewhere in this
 * file, since jira_search's plain-JQL mode returns this flatter shape.
 * `duedate` did not appear on any real result during verification (either
 * genuinely unset on those tickets, or not surfaced by this tool at all) —
 * read defensively and treated as absent when missing.
 */
export async function getMyOpenJiraIssues(limit = 20): Promise<JiraTaskMatch[]> {
  if (!isJiraConfigured()) {
    throw new Error('Jira is not configured — see NOTES.md.');
  }

  const jql = `assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC, updated DESC`;
  const result = await getClient().callTool('jira_search', {
    jql,
    limit,
    fields: 'summary,status,assignee,updated,issuetype,priority,duedate',
  });

  const text = extractResultText(result);
  if (!text || result?.isError) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const issues = Array.isArray(parsed) ? parsed : (parsed.issues ?? parsed.values ?? []);
  return issues.map((issue: any) => ({
    key: issue.key,
    summary: issue.summary ?? issue.fields?.summary ?? '',
    url: issue.browse_url ?? issueUrl(issue.key),
    priorityName: issue.priority?.name ?? issue.fields?.priority?.name ?? null,
    statusName: issue.status?.name ?? issue.fields?.status?.name ?? null,
    dueDate: issue.due_date ?? issue.duedate ?? issue.fields?.duedate ?? null,
    updated: issue.updated ?? issue.fields?.updated ?? null,
  }));
}

export interface CreateJiraIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
}

export interface JiraIssueResult {
  key: string;
  url: string;
}

function issueUrl(key: string): string {
  return `${config.jiraUrl.replace(/\/$/, '')}/browse/${key}`;
}

/**
 * Real write — actually creates a Jira issue via mcp-atlassian's
 * jira_create_issue tool (exact parameter names verified against the
 * project's own tools-reference docs, not guessed). Never called from the
 * fact-check/live-Q&A paths (those only ever use the read-only helpers
 * above) — this is only reachable from the Action Items tab's explicit
 * "Create/update Jira" dialog, one click at a time.
 */
export async function createJiraIssue(input: CreateJiraIssueInput): Promise<JiraIssueResult> {
  if (!isJiraConfigured()) {
    throw new Error('Jira is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('jira_create_issue', {
    project_key: input.projectKey,
    issue_type: input.issueType,
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
  });
  const text = extractResultText(result);
  if (result?.isError) {
    throw new Error(text || 'Failed to create Jira issue.');
  }
  let key: string | undefined;
  try {
    const parsed = JSON.parse(text);
    key = parsed.key ?? parsed.issue?.key;
  } catch {
    // Not JSON-parseable, but isError was false — the issue was very likely
    // still created; fall through to the "no key found" error below rather
    // than silently reporting success with no way to link to it.
  }
  if (!key) {
    throw new Error(`Jira issue may have been created, but its key could not be parsed from the response: ${text.slice(0, 300)}`);
  }
  return { key, url: issueUrl(key) };
}

export interface UpdateJiraIssueInput {
  issueKey: string;
  transition?: string;
  comment?: string;
}

/** Real write — transitions status and/or adds a comment on an existing issue via jira_update_issue. At least one of transition/comment is required (enforced by the caller, src/interface/server.ts). */
export async function updateJiraIssue(input: UpdateJiraIssueInput): Promise<JiraIssueResult> {
  if (!isJiraConfigured()) {
    throw new Error('Jira is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('jira_update_issue', {
    issue_key: input.issueKey,
    ...(input.transition ? { transition: input.transition } : {}),
    ...(input.comment ? { comment: input.comment } : {}),
  });
  const text = extractResultText(result);
  if (result?.isError) {
    throw new Error(text || 'Failed to update Jira issue.');
  }
  return { key: input.issueKey, url: issueUrl(input.issueKey) };
}

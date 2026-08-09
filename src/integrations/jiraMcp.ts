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

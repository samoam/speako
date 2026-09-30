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
export function extractIssueKeys(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
  return [...new Set(matches)];
}

export interface JiraIssueDetail {
  key: string;
  summary: string;
  description: string;
  status: string;
}

/**
 * Full-description variant of getJiraIssue() below — that one deliberately
 * keeps only summary+status (a short JiraMatch snippet, good enough for
 * fact-checking a claim). The PR-review flow needs the actual description
 * body (acceptance criteria, context for *why* the change exists), so this
 * requests a wider field set and returns an untruncated shape instead.
 */
export async function getJiraIssueDetail(issueKey: string): Promise<JiraIssueDetail | null> {
  if (!isJiraConfigured()) {
    throw new Error('Jira is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('jira_get_issue', {
    issue_key: issueKey,
    fields: 'summary,description,status,issuetype',
  });

  const text = extractResultText(result);
  if (!text || result?.isError) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  return {
    key: parsed.key ?? issueKey,
    summary: parsed.fields?.summary ?? parsed.summary ?? '',
    description: parsed.fields?.description ?? parsed.description ?? '',
    status: parsed.fields?.status?.name ?? parsed.status?.name ?? parsed.status ?? '',
  };
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

/**
 * Fetches one issue by key, shaped as a JiraTaskMatch so it can go straight
 * into taskSync.ts's jiraIssueToTask() — the single-issue counterpart to
 * getMyOpenJiraIssues() above, used by addManualTask() (src/orchestrator/
 * manualTask.ts) when the user types in a ticket that isn't assigned to
 * them (so the bulk "my open issues" JQL would never surface it). Unlike
 * getMyOpenJiraIssues's jira_search response, a single jira_get_issue
 * response is the REST API's nested `fields: {...}` shape (same as
 * getJiraIssueDetail above), not the flatter jira_search shape — read
 * accordingly. Returns null (not a throw) for "no such issue"/malformed
 * response, so the caller can turn that into a 404.
 */
export async function getJiraIssueByKey(issueKey: string): Promise<JiraTaskMatch | null> {
  if (!isJiraConfigured()) {
    throw new Error('Jira is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('jira_get_issue', {
    issue_key: issueKey,
    fields: 'summary,status,assignee,updated,issuetype,priority,duedate',
  });

  const text = extractResultText(result);
  if (!text || result?.isError) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const summary = parsed.fields?.summary ?? parsed.summary ?? '';
  if (!parsed.key && !summary) return null;

  return {
    key: parsed.key ?? issueKey,
    summary,
    url: issueUrl(parsed.key ?? issueKey),
    priorityName: parsed.fields?.priority?.name ?? parsed.priority?.name ?? null,
    statusName: parsed.fields?.status?.name ?? parsed.status?.name ?? null,
    dueDate: parsed.fields?.duedate ?? parsed.duedate ?? null,
    updated: parsed.fields?.updated ?? parsed.updated ?? null,
  };
}

export interface JiraCommentMention {
  issueKey: string;
  issueSummary: string;
  /** The issue's own priority name (e.g. "Blocker", "Medium") — lets taskSync.ts score a comment on a Blocker ticket higher than one on a Trivial ticket via the same jiraImportance() mapping the issue itself uses. Null if Jira omitted the field. */
  priorityName: string | null;
  commentId: string;
  authorName: string;
  text: string;
  createdDate: string;
  url: string;
}

/** Best-effort plain-text extraction from a Jira comment body — Jira Server/DC returns wiki markup (a plain string) for `comment_limit`-included comments in mcp-atlassian's normalized JSON, but this is defensive against an ADF/ProseMirror object shape too (Jira Cloud), same "never assume the exact shape" caution as getJiraIssueDetail's description parsing. */
function commentBodyText(comment: any): string {
  const raw = comment?.body ?? comment?.text ?? comment?.content ?? '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/**
 * New comments (not authored by config.jiraUserIdentifier) on issues the
 * current user is assigned to or watching — the "jira comments" message
 * source for the orchestrator's tasks board (src/orchestrator/taskSync.ts),
 * filling the gap getMyOpenJiraIssues() leaves (issues, not activity on
 * them). Unlike getMyOpenJiraIssues, there's no single JQL that can filter
 * by comment content/author, so this is a two-step fetch: a JQL candidate
 * search (same jira_search shape as getMyOpenJiraIssues), then one
 * jira_get_issue({include: 'comments'}) per candidate. NOT yet confirmed
 * live against a real mcp-atlassian instance — see NOTES.md/plan doc for
 * what to check on the first real run.
 */
export async function getJiraCommentMentions(limit = 25): Promise<JiraCommentMention[]> {
  if (!isJiraConfigured() || !config.jiraUserIdentifier) return [];

  const jql = `(assignee = currentUser() OR watcher = currentUser()) AND updated >= -3d ORDER BY updated DESC`;
  const searchResult = await getClient().callTool('jira_search', {
    jql,
    limit,
    fields: 'summary',
  });
  const searchText = extractResultText(searchResult);
  if (!searchText || searchResult?.isError) return [];

  let parsedSearch: any;
  try {
    parsedSearch = JSON.parse(searchText);
  } catch {
    return [];
  }
  const candidates = Array.isArray(parsedSearch) ? parsedSearch : (parsedSearch.issues ?? parsedSearch.values ?? []);
  const myIdentifier = config.jiraUserIdentifier.toLowerCase();

  const mentions: JiraCommentMention[] = [];
  for (const candidate of candidates) {
    const issueKey = candidate.key;
    if (!issueKey) continue;
    try {
      const result = await getClient().callTool('jira_get_issue', {
        issue_key: issueKey,
        fields: 'summary,priority',
        include: 'comments',
        comment_limit: 20,
      });
      const text = extractResultText(result);
      if (!text || result?.isError) continue;

      const parsed = JSON.parse(text);
      const issueSummary: string = parsed.fields?.summary ?? parsed.summary ?? candidate.summary ?? '';
      const priorityName: string | null = parsed.fields?.priority?.name ?? parsed.priority?.name ?? null;
      const comments: any[] = parsed.comments ?? parsed.fields?.comment?.comments ?? [];

      for (const comment of comments) {
        const authorIdentifier: string = (comment.author?.emailAddress ?? comment.author?.name ?? comment.author?.accountId ?? comment.author?.displayName ?? '').toLowerCase();
        if (!authorIdentifier || authorIdentifier === myIdentifier) continue;
        const commentId = comment.id != null ? String(comment.id) : null;
        if (!commentId) continue;
        mentions.push({
          issueKey,
          issueSummary,
          priorityName,
          commentId,
          authorName: comment.author?.displayName ?? comment.author?.name ?? 'unknown',
          text: commentBodyText(comment),
          createdDate: comment.created ?? new Date().toISOString(),
          url: `${issueUrl(issueKey)}?focusedCommentId=${commentId}`,
        });
      }
    } catch (err: any) {
      console.error(`[jira] failed to fetch comments for ${issueKey}:`, err.message);
    }
  }

  return mentions;
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

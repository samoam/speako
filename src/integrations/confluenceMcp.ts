import { config } from '../config';
import { getAtlassianClient as getClient } from './atlassianMcp';

export interface ConfluenceMatch {
  path: string;
  snippet: string;
  /** Confluence page id, when the search result included one — lets a caller follow up with getConfluencePage() for the full body instead of this 300-char snippet. Undefined for the plain-text-fallback branch below, which has no id to extract. */
  id?: string;
}

export function isConfluenceConfigured(): boolean {
  return !!(config.confluenceUrl && config.confluenceUsername && config.confluenceApiToken);
}

function extractResultText(result: any): string {
  if (typeof result?.structuredContent?.result === 'string') return result.structuredContent.result;
  const textBlock = result?.content?.find((c: any) => c.type === 'text');
  if (textBlock?.text) return textBlock.text;
  return '';
}

/**
 * Searches Confluence via the `mcp-atlassian` MCP server's read-only
 * `confluence_search` tool — accepts plain free text directly (falls back
 * from siteSearch to text search internally), so the claim/question is
 * passed through as-is rather than converted to CQL.
 */
export async function searchConfluence(query: string, limit = 5): Promise<ConfluenceMatch[]> {
  if (!isConfluenceConfigured()) {
    throw new Error('Confluence is not configured — see NOTES.md.');
  }

  const result = await getClient().callTool('confluence_search', { query, limit });

  const text = extractResultText(result);
  if (!text) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ path: 'confluence', snippet: text.slice(0, 1500) }];
  }

  const pages = Array.isArray(parsed) ? parsed : (parsed.results ?? parsed.values ?? []);
  return pages.slice(0, limit).map((page: any) => ({
    path: page.title ?? page.id ?? 'confluence',
    id: page.id ? String(page.id) : undefined,
    snippet: (page.excerpt ?? page.content?.excerpt ?? '').replace(/<[^>]+>/g, '').slice(0, 300),
  }));
}

export interface ConfluencePage {
  title: string;
  content: string;
}

/**
 * Full page body, not just a search snippet — used by the PR-review flow to
 * pull complete context from a linked design doc rather than a 300-char
 * excerpt. Response shape confirmed live against the real mcp-atlassian
 * server: { metadata: { title, content: { value } } }.
 */
export async function getConfluencePage(pageId: string): Promise<ConfluencePage> {
  if (!isConfluenceConfigured()) {
    throw new Error('Confluence is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('confluence_get_page', { page_id: pageId });
  const text = extractResultText(result);
  if (!text || result?.isError) {
    throw new Error(`Could not fetch Confluence page ${pageId}.`);
  }
  const parsed = JSON.parse(text);
  return {
    title: parsed.metadata?.title ?? pageId,
    content: parsed.metadata?.content?.value ?? '',
  };
}

export interface CreateConfluencePageInput {
  spaceKey: string;
  title: string;
  content: string;
  parentId?: string;
}

export interface ConfluencePageResult {
  id: string;
  url: string;
}

/**
 * Real write — actually creates a page via mcp-atlassian's
 * confluence_create_page tool (parameter names verified against the
 * project's own tools-reference docs). Only reachable from the Action
 * Items tab's explicit "Create/update Confluence" dialog.
 */
export async function createConfluencePage(input: CreateConfluencePageInput): Promise<ConfluencePageResult> {
  if (!isConfluenceConfigured()) {
    throw new Error('Confluence is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('confluence_create_page', {
    space_key: input.spaceKey,
    title: input.title,
    content: input.content,
    ...(input.parentId ? { parent_id: input.parentId } : {}),
  });
  const text = extractResultText(result);
  if (result?.isError) {
    throw new Error(text || 'Failed to create Confluence page.');
  }
  let id: string | undefined;
  let webui: string | undefined;
  try {
    const parsed = JSON.parse(text);
    id = parsed.id ?? parsed.page?.id;
    webui = parsed._links?.webui ?? parsed.page?._links?.webui;
  } catch {
    // Not JSON-parseable, but isError was false — see createJiraIssue's identical caveat.
  }
  if (!id) {
    throw new Error(`Confluence page may have been created, but its id could not be parsed from the response: ${text.slice(0, 300)}`);
  }
  const base = config.confluenceUrl.replace(/\/$/, '');
  return { id, url: webui ? `${base}${webui}` : base };
}

export interface UpdateConfluencePageInput {
  pageId: string;
  title: string;
  content: string;
}

/** Real write — replaces a page's title/content via confluence_update_page. Confluence requires the full title on every update, not just a content delta. */
export async function updateConfluencePage(input: UpdateConfluencePageInput): Promise<ConfluencePageResult> {
  if (!isConfluenceConfigured()) {
    throw new Error('Confluence is not configured — see NOTES.md.');
  }
  const result = await getClient().callTool('confluence_update_page', {
    page_id: input.pageId,
    title: input.title,
    content: input.content,
  });
  const text = extractResultText(result);
  if (result?.isError) {
    throw new Error(text || 'Failed to update Confluence page.');
  }
  return { id: input.pageId, url: config.confluenceUrl.replace(/\/$/, '') };
}

import { config } from '../config';
import { getAtlassianClient as getClient } from './atlassianMcp';

export interface ConfluenceMatch {
  path: string;
  snippet: string;
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
    snippet: (page.excerpt ?? page.content?.excerpt ?? '').replace(/<[^>]+>/g, '').slice(0, 300),
  }));
}

import { config } from '../config';
import { McpServerClient } from '../mcp/mcpClient';
import { onSettingsChanged } from '../settingsStore';

export interface Mem0Match {
  memory: string;
  score?: number;
}

let mcpClient: McpServerClient | null = null;
function getClient(): McpServerClient {
  if (!mcpClient) {
    mcpClient = new McpServerClient({
      transport: 'http',
      url: config.mem0McpUrl,
      apiKey: config.mem0McpApiKey,
    });
  }
  return mcpClient;
}

onSettingsChanged(() => {
  mcpClient?.close();
  mcpClient = null;
});

export function isMem0Configured(): boolean {
  return !!(config.mem0McpUrl && config.mem0McpApiKey);
}

/** Closes the underlying MCP connection — the long-running app never needs this, but a short-lived process (tests, CLI scripts) won't exit on its own while the connection is open. */
export function closeMem0Client(): void {
  mcpClient?.close();
  mcpClient = null;
}

function extractResultText(result: any): string {
  if (typeof result?.structuredContent?.result === 'string') return result.structuredContent.result;
  const textBlock = result?.content?.find((c: any) => c.type === 'text');
  if (textBlock?.text) return textBlock.text;
  return '';
}

/** Durable cross-meeting facts about people/topics — read during one-on-one prep. */
export async function searchMemory(query: string, limit = 5): Promise<Mem0Match[]> {
  if (!isMem0Configured()) {
    throw new Error('mem0 is not configured — see NOTES.md.');
  }

  const result = await getClient().callTool('search_memory', { query, limit });
  const text = extractResultText(result);
  if (!text) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const results = parsed?.result?.results ?? [];
  return results.slice(0, limit).map((r: any) => ({ memory: r.memory, score: r.score }));
}

/**
 * Writes a short, distilled durable fact to mem0 — call this with a single
 * sentence extracted from a meeting's key decisions/action items, never the
 * raw transcript. Kept intentionally low-volume so the memory store doesn't
 * fill up with transcript-derived noise.
 */
export async function addMemory(content: string, userId?: string): Promise<void> {
  if (!isMem0Configured()) {
    throw new Error('mem0 is not configured — see NOTES.md.');
  }
  await getClient().callTool('add_memory', userId ? { content, user_id: userId } : { content });
}

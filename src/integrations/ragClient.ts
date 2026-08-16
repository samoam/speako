import { config } from '../config';
import { McpServerClient } from '../mcp/mcpClient';
import { onSettingsChanged } from '../settingsStore';

export interface RagMatch {
  text: string;
  score: number;
  title?: string;
  sourceType?: string;
}

let mcpClient: McpServerClient | null = null;
function getClient(): McpServerClient {
  if (!mcpClient) {
    mcpClient = new McpServerClient({
      transport: 'http',
      url: config.ragMcpUrl,
      apiKey: config.ragMcpApiKey,
    });
  }
  return mcpClient;
}

onSettingsChanged(() => {
  mcpClient?.close();
  mcpClient = null;
});

export function isRagConfigured(): boolean {
  return !!(config.ragMcpUrl && config.ragMcpApiKey);
}

/** Closes the underlying MCP connection — the long-running app never needs this, but a short-lived process (tests, CLI scripts) won't exit on its own while the connection is open. */
export function closeRagClient(): void {
  mcpClient?.close();
  mcpClient = null;
}

function extractResult(result: any): any {
  const textBlock = result?.content?.find((c: any) => c.type === 'text');
  if (!textBlock?.text) return null;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return null;
  }
}

export async function search(query: string, limit = 5): Promise<RagMatch[]> {
  if (!isRagConfigured()) {
    throw new Error('rag-cloud (MyRAG) is not configured — see NOTES.md.');
  }
  const result = extractResult(await getClient().callTool('search', { query, top_k: limit }));
  if (!result?.ok) return [];
  return (result.results ?? []).map((r: any) => ({
    text: r.text,
    score: r.score,
    title: r.title,
    sourceType: r.source_type,
  }));
}

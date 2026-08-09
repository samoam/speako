import { config } from '../config';
import { McpServerClient } from '../mcp/mcpClient';
import { onSettingsChanged } from '../settingsStore';

/**
 * `mcp-atlassian` is ONE server exposing both jira_* and confluence_* tools
 * — jiraMcp.ts and confluenceMcp.ts used to each spawn their own subprocess
 * of it via independent module-level singletons. Discovered live: calling
 * both concurrently (as the standup prep workflow now does, querying Jira
 * and Confluence in the same Promise.all) caused two concurrent `uvx
 * mcp-atlassian` cold-starts, which `uv`'s cache-locking serializes/stalls
 * badly under contention — observed hangs of several minutes instead of the
 * normal ~15-20s single-spawn cold start. Sharing one client here (both
 * modules import getAtlassianClient() instead of constructing their own)
 * fixes this at the root and is simply correct: one server, one subprocess.
 */
let sharedClient: McpServerClient | null = null;
export function getAtlassianClient(): McpServerClient {
  if (!sharedClient) {
    sharedClient = new McpServerClient({
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: {
        ...process.env,
        JIRA_URL: config.jiraUrl,
        JIRA_PERSONAL_TOKEN: config.jiraPersonalToken,
        CONFLUENCE_URL: config.confluenceUrl,
        CONFLUENCE_USERNAME: config.confluenceUsername,
        CONFLUENCE_API_TOKEN: config.confluenceApiToken,
      } as Record<string, string>,
    });
  }
  return sharedClient;
}

onSettingsChanged(() => {
  sharedClient?.close();
  sharedClient = null;
});

// @modelcontextprotocol/sdk is ESM-only ("type": "module") but ships a working
// .cjs build for require() — same situation as @google/genai elsewhere in this
// project. require() sidesteps the ESM/CJS boundary that a static `import`
// would fail under this project's CommonJS + node16 module resolution.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Thin wrapper around one MCP server subprocess, connected lazily on first
 * use and kept alive for reuse (spawning a fresh process per query would be
 * slow and wasteful). Tool names/schemas are NOT assumed — call listTools()
 * to discover them for real before calling callTool() with guessed arguments.
 */
export class McpServerClient {
  private client: any = null;
  private connecting: Promise<any> | null = null;

  constructor(private config: McpServerConfig) {}

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
      });
      const client = new Client({ name: 'speako', version: '1.0.0' });
      await client.connect(transport);
      this.client = client;
      return client;
    })();

    return this.connecting;
  }

  async listTools(): Promise<McpTool[]> {
    const client = await this.getClient();
    const result = await client.listTools();
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const client = await this.getClient();
    return client.callTool({ name, arguments: args });
  }
}

import { execFile } from 'child_process';

// @modelcontextprotocol/sdk is ESM-only ("type": "module") but ships a working
// .cjs build for require() — same situation as @google/genai elsewhere in this
// project. require() sidesteps the ESM/CJS boundary that a static `import`
// would fail under this project's CommonJS + node16 module resolution.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

export type McpServerConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { transport: 'http'; url: string; apiKey: string };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const CALL_TOOL_TIMEOUT_MS = 20_000;

/**
 * Thin wrapper around one MCP server subprocess, connected lazily on first
 * use and kept alive for reuse (spawning a fresh process per query would be
 * slow and wasteful). Tool names/schemas are NOT assumed — call listTools()
 * to discover them for real before calling callTool() with guessed arguments.
 */
export class McpServerClient {
  private client: any = null;
  private connecting: Promise<any> | null = null;
  private stdioTransport: any = null;

  constructor(private config: McpServerConfig) {}

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport =
        this.config.transport === 'http'
          ? new StreamableHTTPClientTransport(new URL(this.config.url), {
              requestInit: { headers: { Authorization: `Bearer ${this.config.apiKey}` } },
            })
          : new StdioClientTransport({
              command: this.config.command,
              args: this.config.args,
              env: this.config.env,
            });
      if (this.config.transport === 'stdio') {
        this.stdioTransport = transport;
      }
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
    // The SDK's own default (60s) is generous for what's meant to be a live,
    // in-meeting fact-check/QA lookup — callers (factcheck.ts, liveQa.ts) have
    // their own fallback paths (web search) that should get a chance to run
    // well within a live turn rather than after a full minute of hanging.
    return client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TOOL_TIMEOUT_MS });
  }

  /** Closes the underlying transport (kills the stdio subprocess, if any) and drops the cached client so the next call reconnects fresh. */
  close(): void {
    const pid = this.stdioTransport?.pid ?? null;
    this.client?.close?.();
    this.client = null;
    this.connecting = null;
    this.stdioTransport = null;

    // On Windows, child.kill() (used internally by the SDK's transport.close())
    // only signals the immediately-spawned process. Tools launched via `uvx`
    // spawn a chain of further descendants (uv -> mcp-atlassian.exe -> python.exe)
    // that don't relay the signal and survive as orphans. taskkill /T force-kills
    // the whole tree; POSIX process groups don't have this problem.
    if (pid && process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
    }
  }
}

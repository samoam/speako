import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const CONNECTOR_PREFIX = 'mcp__claude_ai_Microsoft_365__';

/**
 * Dispatches ONE Microsoft 365 connector tool call through a headless
 * `claude -p` process — the connector (`claude.ai Microsoft 365`,
 * https://microsoft365.mcp.claude.com/mcp) is registered globally for this
 * OS user via `claude mcp` (confirmed live: `claude mcp list` shows it
 * "Connected", same registration scope the existing jira-acceo/
 * confluence-acceo/jenkins-acceo MCP servers already use), and is
 * authenticated as the real primary mailbox (confirmed live via `get_me`:
 * mourad.adadi@gtechna.com, no #EXT# guest suffix) — not the B2B-guest
 * identity that blocked the old direct-Graph/Teams integration (see
 * NOTES.md). Speako talks to it by asking a disposable `claude` subprocess
 * to make exactly one tool call, the same way claudeCodeCli.ts's
 * runClaudeCodeReview already shells out to `claude` for code reviews.
 *
 * Confirmed live, all in this session, against the real mailbox/calendar:
 * - `--allowedTools "mcp__claude_ai_Microsoft_365__<tool>"` pre-approves
 *   exactly that one tool with no interactive permission prompt/hang.
 * - The full tool name really is `mcp__claude_ai_Microsoft_365__<toolName>`
 *   (matches this chat session's own tool names exactly).
 * - The real payload lands as a `tool_result` content block on a
 *   `type: 'user'` stream event, correlated to its `type: 'tool_use'` block
 *   (on a `type: 'assistant'` event) via `tool_use.id` === `tool_result.tool_use_id`
 *   — never trust the model's final text turn to transcribe the data
 *   faithfully, same principle claudeCodeCli.ts's runClaudeCodeReview
 *   already follows for structured output.
 * - A list-returning tool (outlook_email_search, outlook_calendar_search)
 *   returns ONE JSON object PER `content` block, not one concatenated blob —
 *   the last block is often trailing pagination metadata
 *   (`{moreResults, nextOffset, totalResultCount}`). callMicrosoft365Tool
 *   returns the array of parsed blocks as-is; callers that expect a single
 *   object (e.g. a create/send call) just take element 0.
 * - A cheap/fast model (`claude-haiku-4-5-20251001`) is forced on every
 *   call — this is a pure single-tool relay, not a reasoning task, and
 *   using a smaller model cuts both latency and subscription-quota usage
 *   for what becomes a frequently-polled call site (email sync).
 */
export interface ConnectorToolCall {
  /** Bare tool name, e.g. 'outlook_email_search' — the mcp__claude_ai_Microsoft_365__ prefix is added internally. */
  tool: string;
  args: Record<string, unknown>;
}

/** Thrown for anything from a connector-tool dispatch: process/spawn errors, a tool_result marked is_error, an unparseable result, or a timeout. */
export class ConnectorToolError extends Error {}

function buildPrompt(fullToolName: string, args: Record<string, unknown>): string {
  return `Call the tool "${fullToolName}" with these exact arguments (JSON): ${JSON.stringify(args)}. Call it exactly once, with no other tool calls. After it returns, respond with only the word DONE — do not summarize, describe, or restate the result yourself.`;
}

/** Parses each tool_result content block as its own JSON object — see the module comment above for why this must not be joined into one string first. Falls back to the raw text for a block that isn't valid JSON, rather than dropping it silently. */
function parseResultBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.map((block: any) => {
    const text = block?.type === 'text' ? block.text : typeof block === 'string' ? block : '';
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  });
}

export async function callMicrosoft365Tool<T = any>(call: ConnectorToolCall, opts?: { timeoutMs?: number }): Promise<T[]> {
  const fullToolName = `${CONNECTOR_PREFIX}${call.tool}`;
  const prompt = buildPrompt(fullToolName, call.args);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', 'claude-haiku-4-5-20251001',
      '--allowedTools', fullToolName,
      '--disallowedTools', 'Bash(*:*)', 'Write', 'Edit',
    ]);

    let buffer = '';
    let stderrOutput = '';
    let settled = false;
    let pendingToolUseId: string | null = null;
    let resultBlocks: unknown[] | null = null;
    let resultError: string | null = null;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ConnectorToolError(`Connector call to "${fullToolName}" timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // a partial/corrupt line shouldn't crash the whole dispatch — just skip it
        }

        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use' && block.name === fullToolName) {
              pendingToolUseId = block.id;
            }
          }
        } else if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result' && block.tool_use_id === pendingToolUseId) {
              if (block.is_error) {
                const errorText = Array.isArray(block.content)
                  ? block.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join(' ')
                  : String(block.content ?? '');
                resultError = errorText || `Connector tool "${fullToolName}" returned an error.`;
              } else {
                resultBlocks = parseResultBlocks(block.content);
              }
            }
          }
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      settle();
      reject(err);
    });

    child.on('close', (code) => {
      settle();
      if (resultError) {
        reject(new ConnectorToolError(resultError));
      } else if (resultBlocks !== null) {
        resolve(resultBlocks as T[]);
      } else {
        reject(
          new ConnectorToolError(
            `Connector call to "${fullToolName}" exited with code ${code} without returning a result.${stderrOutput ? ` ${stderrOutput.slice(0, 500)}` : ''}`
          )
        );
      }
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export interface PaginateConnectorToolOptions {
  tool: string;
  args: Record<string, unknown>;
  /** 'offset' (default) reads args.offset back from moreResults/nextOffset — outlook_email_search, chat_message_search, outlook_calendar_search. 'cursor' reads args.cursor back from moreResults/nextCursor — teams_list_chats. */
  paging?: 'offset' | 'cursor';
}

/**
 * Shared page-through-every-result loop for connector tools that return a
 * list — outlookMailSync.ts, teamsConnectorSync.ts, and
 * microsoft365Calendar.ts each repeated this exact shape independently
 * before it was extracted here: fetch one page, keep every block that looks
 * like a real item (has an `id`), find the trailing pagination-metadata
 * block, and continue until the connector reports no more results.
 */
export async function paginateConnectorTool<T = any>(options: PaginateConnectorToolOptions): Promise<T[]> {
  const paging = options.paging ?? 'offset';
  const items: T[] = [];
  let offset = 0;
  let cursor: string | undefined;

  for (;;) {
    const args = paging === 'cursor' ? { ...options.args, ...(cursor ? { cursor } : {}) } : { ...options.args, offset };
    const blocks = await callMicrosoft365Tool<any>({ tool: options.tool, args });
    for (const block of blocks) {
      if (block && typeof block === 'object' && 'id' in block) items.push(block as T);
    }
    const pagination = blocks.find((b: any) => b && typeof b === 'object' && 'moreResults' in b) as
      | { moreResults?: boolean; nextOffset?: number; nextCursor?: string }
      | undefined;
    if (!pagination?.moreResults) break;
    if (paging === 'cursor') {
      if (!pagination.nextCursor) break;
      cursor = pagination.nextCursor;
    } else {
      if (pagination.nextOffset == null) break;
      offset = pagination.nextOffset;
    }
  }

  return items;
}

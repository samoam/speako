import { spawn } from 'child_process';
import * as os from 'os';

export type ClaudeTextModel = 'haiku' | 'sonnet' | 'opus';

export interface ClaudeTextResult {
  text: string;
  structured: any;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * One tool-less `claude -p` turn for plain prose/JSON work (subscription
 * billed, unlike the metered Gemini API). Confirmed live (2026-09-30,
 * Claude Code 2.1.282): with the default system prompt, settings and MCP
 * servers a two-line email took 22s and ~45k context tokens; with
 * `--system-prompt` + `--tools ""` + `--strict-mcp-config` +
 * `--setting-sources ""` the same call took ~5s and ~2.3k tokens, and
 * `--json-schema` still returned `structured_output` already parsed. Too slow
 * for per-segment live-meeting work — meant for background and on-click
 * tasks. Runs from os.tmpdir() so no project CLAUDE.md is ever picked up.
 * `--bare` would be leaner still, but it refuses OAuth, i.e. the subscription.
 */
export function runClaudeText(
  prompt: string,
  options: { model: ClaudeTextModel; jsonSchema?: object; systemPrompt?: string; timeoutMs?: number }
): Promise<ClaudeTextResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model', options.model,
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt', options.systemPrompt ?? 'You are a precise assistant. Return only what is asked for.',
        '--output-format', 'json',
        ...(options.jsonSchema ? ['--json-schema', JSON.stringify(options.jsonSchema)] : []),
      ],
      { cwd: os.tmpdir() }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Claude Code text call timed out.')));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      finish(() => {
        let parsed: any;
        try {
          parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '');
        } catch {
          reject(new Error(`Claude Code exited with code ${code} without a JSON result.${stderr ? ` ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        if (parsed.is_error) {
          reject(new Error(`Claude Code returned an error: ${String(parsed.result ?? '').slice(0, 300)}`));
          return;
        }
        if (options.jsonSchema && parsed.structured_output == null) {
          reject(new Error('Claude Code returned no structured_output for a --json-schema call.'));
          return;
        }
        const usage = Object.values(parsed.modelUsage ?? {}) as any[];
        resolve({
          text: parsed.result ?? '',
          structured: parsed.structured_output ?? null,
          inputTokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0),
          outputTokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
        });
      });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

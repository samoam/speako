import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';

const execFileAsync = promisify(execFile);

/**
 * Hard-blocks git commit/push from inside the Claude Code agent itself,
 * confirmed via a real test against a disposable repo: asking the agent to
 * both make a file edit AND commit it resulted in the edit landing
 * (permission-mode acceptEdits) but the commit call being denied outright —
 * `git log` showed no new commit. This is the actual safety mechanism
 * behind "no commit or push unless approved" — approval is a separate,
 * later step (applyCodeChangeToRepo/pushRepo below) that Speako's own code
 * runs, never something the agent does on its own.
 */
const DISALLOWED_TOOLS = ['Bash(git commit:*)', 'Bash(git push:*)'];

/**
 * `--permission-mode acceptEdits` alone was confirmed flaky for brand-new
 * file creation in a live smoke test: it sometimes silently auto-accepted
 * a `Write` for a new file and sometimes left the agent hung forever on an
 * interactive "Do you want to create X?" prompt it can never answer in
 * `--bg` (headless, no TTY to respond to). Explicitly allowing Write/Edit
 * closed that race in repeated reruns — worth keeping even though
 * acceptEdits should, in principle, already cover this.
 */
const ALLOWED_TOOLS = ['Write', 'Edit'];

const SPAWN_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 30_000;

export function isClaudeCodeConfigured(): boolean {
  return config.codebaseLocalPaths.length > 0;
}

/** Resolves a configured local codebase by name (see config.ts's codebaseLocalPaths) — e.g. "officercc" — to its real filesystem path. */
export function resolveLocalRepoPath(name: string): string {
  const entry = config.codebaseLocalPaths.find((p) => p.name === name);
  if (!entry) {
    throw new Error(`No local codebase configured named "${name}" — see Settings > Local codebase indexing.`);
  }
  return entry.path;
}

export interface ClaudeCodeTaskHandle {
  cliSessionId: string;
}

/**
 * Launches a background Claude Code agent (`claude --bg`) in a fresh,
 * isolated git worktree under `repoPath` — never the repo's actual working
 * directory, so nothing here can disturb whatever the user has checked out
 * or in progress there. `--bg` and `-p/--print` are mutually exclusive (a
 * real CLI error, not a guess) — background mode is what makes this
 * pollable via getTaskInfo() instead of blocking Speako's process for
 * however long the task takes.
 */
export async function startClaudeCodeTask(prompt: string, repoPath: string): Promise<ClaudeCodeTaskHandle> {
  const { stdout } = await execFileAsync(
    'claude',
    [
      '--bg', prompt, '--worktree',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ...ALLOWED_TOOLS,
      '--disallowedTools', ...DISALLOWED_TOOLS,
    ],
    { cwd: repoPath, timeout: SPAWN_TIMEOUT_MS }
  );
  const match = stdout.match(/backgrounded\s*[·:]\s*(\S+)/);
  if (!match) {
    throw new Error(`Could not parse a session id from Claude Code's output: ${stdout.slice(0, 300)}`);
  }
  return { cliSessionId: match[1] };
}

export interface ClaudeCodeAgentInfo {
  id: string;
  cwd: string;
  state: string; // e.g. 'running', 'done', 'blocked', 'stopped' — confirmed empirically, not officially enumerated by the CLI's --help
  name: string;
}

/** `claude agents --json --all` lists every background/interactive session this machine knows about — filtered here to the one Speako started. Returns null if the CLI has since forgotten about it (e.g. after a `claude rm`). */
export async function getTaskInfo(cliSessionId: string): Promise<ClaudeCodeAgentInfo | null> {
  const { stdout } = await execFileAsync('claude', ['agents', '--json', '--all'], { timeout: SPAWN_TIMEOUT_MS });
  const agents: any[] = JSON.parse(stdout);
  const found = agents.find((a) => a.id === cliSessionId);
  return found ? { id: found.id, cwd: found.cwd, state: found.state, name: found.name } : null;
}

export async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

// A real fetch + worktree checkout against a large repo (confirmed live: one
// with 15k+ tracked files) takes meaningfully longer than the 30s GIT_TIMEOUT_MS
// used for the small, targeted git calls elsewhere in this file (diff/commit/
// push all operate on an already-checked-out worktree, not a fresh full copy).
const WORKTREE_CHECKOUT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Unlike startClaudeCodeTask's --worktree (which always creates a fresh
 * worktree off the repo's current HEAD, with no way to target an existing
 * branch), a PR review needs to actually check out the PR's real source
 * branch — so this creates the worktree explicitly rather than fighting
 * --worktree's behavior.
 */
export async function createWorktreeForBranch(repoPath: string, branch: string): Promise<string> {
  await git(['fetch', 'origin', branch], repoPath, WORKTREE_CHECKOUT_TIMEOUT_MS);
  const worktreePath = path.join(os.tmpdir(), `speako-pr-review-${Date.now()}`);
  await git(['worktree', 'add', worktreePath, `origin/${branch}`], repoPath, WORKTREE_CHECKOUT_TIMEOUT_MS);
  return worktreePath;
}

/**
 * Cleanup for createWorktreeForBranch's worktree — same --force --force
 * shape as discardCodeChangeTask (a locked working tree needs it passed
 * twice), but no `claude stop` step: runClaudeCodeReview below is a
 * synchronous one-shot call, not a detached background agent to stop first.
 *
 * Retries with a short delay — confirmed live on Windows that calling this
 * immediately after the review subprocess exits can transiently fail (the
 * OS/antivirus can briefly still hold a handle on the worktree directory
 * right after the child process using it as its cwd exits), which otherwise
 * leaves an orphaned worktree directory behind since the caller only logs
 * a cleanup failure rather than retrying itself.
 */
export async function removeWorktree(worktreePath: string, repoPath: string): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await git(['worktree', 'remove', '--force', '--force', worktreePath], repoPath, WORKTREE_CHECKOUT_TIMEOUT_MS);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

const REVIEW_TIMEOUT_MS = 15 * 60 * 1000; // real codebase exploration can take a while, unlike a trivial smoke-test prompt
const REVIEW_DISALLOWED_TOOLS = [...DISALLOWED_TOOLS, 'Write', 'Edit'];

export interface ClaudeCodeReviewResult {
  resultText: string;
  /** Parsed from the CLI's own `structured_output` field when a jsonSchema was supplied — confirmed live that `--json-schema` returns both a JSON string (.result) and this already-parsed object, so callers don't need to JSON.parse resultText themselves. Null if no schema was given, or if the agent's output didn't validate. */
  structuredOutput: any | null;
  isError: boolean;
  costUsd: number;
}

/** Turns a tool-use event into a short, human-readable progress line — confirmed live which tools/fields a review agent actually uses (Bash/Read/Grep/Glob; Write/Edit are disallowed so shouldn't appear). */
function describeToolUse(name: string, input: any): string {
  switch (name) {
    case 'Bash':
      return `Running: ${String(input?.command ?? '').slice(0, 150)}`;
    case 'Read':
      return `Reading ${input?.file_path ?? 'a file'}`;
    case 'Grep':
      return `Searching for "${input?.pattern ?? ''}"${input?.path ? ` in ${input.path}` : ''}`;
    case 'Glob':
      return `Finding files matching "${input?.pattern ?? ''}"`;
    default:
      return `Using ${name}`;
  }
}

/**
 * Streams the review agent's progress live via `--output-format stream-json
 * --include-partial-messages` — confirmed live this emits one JSON object
 * per line as the agent works (tool-use calls with full input once
 * complete, tool results, text deltas, a final `result` line with the same
 * shape the old non-streaming `--output-format json` returned). This
 * replaced an earlier one-shot `-p --output-format json` version once a
 * live progress log was added to the review UI — that version only ever
 * returned a single blob at the very end, leaving the UI with nothing to
 * show while a multi-minute review ran. `--permission-mode plan` plus
 * explicit Write/Edit disallowedTools keeps this strictly read-only — a
 * review agent must never modify the code it's reviewing. Uses spawn (not
 * execFile) specifically to read stdout incrementally as a stream rather
 * than waiting for the whole process to exit.
 *
 * The prompt is piped via stdin rather than passed as a positional argv
 * string — confirmed live that a large, real-world prompt (a full Jira
 * ticket + Confluence page bodies embedded, tens of thousands of characters)
 * broke argv-based invocation: the CLI echoed the prompt text back instead
 * of returning parsed JSON, alongside a "no stdin data received" warning,
 * which is exactly what `-p`'s own --help text hints at ("useful for
 * pipes"). A short smoke-test prompt had worked fine as a positional arg,
 * masking this until a real prompt was tried.
 *
 * options.jsonSchema (confirmed live) constrains the final answer to a
 * given JSON Schema — the CLI returns it in `structured_output`, already
 * parsed, alongside the same JSON as a string in `.result`. Used for the PR
 * review's structured findings (severity/file/line) instead of free-text.
 */
export function runClaudeCodeReview(
  prompt: string,
  worktreePath: string,
  options?: { jsonSchema?: object; onProgress?: (message: string) => void }
): Promise<ClaudeCodeReviewResult> {
  const onProgress = options?.onProgress;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose', // required by the CLI when combining --print with --output-format=stream-json (confirmed live — otherwise it exits immediately with an error)
        '--permission-mode', 'plan',
        '--disallowedTools', ...REVIEW_DISALLOWED_TOOLS,
        ...(options?.jsonSchema ? ['--json-schema', JSON.stringify(options.jsonSchema)] : []),
      ],
      { cwd: worktreePath }
    );

    let buffer = '';
    let stderrOutput = '';
    let finalResult: ClaudeCodeReviewResult | null = null;
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Claude Code review timed out.'));
    }, REVIEW_TIMEOUT_MS);

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
          continue; // a partial/corrupt line shouldn't crash the whole review — just skip it
        }

        if (event.type === 'assistant' && onProgress) {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') onProgress(describeToolUse(block.name, block.input));
          }
        } else if (event.type === 'result') {
          finalResult = {
            resultText: event.result ?? '',
            structuredOutput: event.structured_output ?? null,
            isError: !!event.is_error,
            costUsd: event.total_cost_usd ?? 0,
          };
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (finalResult) {
        resolve(finalResult);
      } else {
        reject(new Error(`Claude Code exited with code ${code} before returning a result.${stderrOutput ? ` ${stderrOutput.slice(0, 500)}` : ''}`));
      }
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

/**
 * Stages everything in the worktree (not a commit — `git add` alone) and
 * diffs against the index, which is what actually surfaces new/untracked
 * files in the diff text; a plain `git diff` alone only shows already-
 * tracked modifications. Returns '' if the agent made no changes at all.
 */
export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  await git(['add', '-A'], worktreePath);
  return git(['diff', '--cached'], worktreePath);
}

/**
 * The actual "approve" action — applies a previously-captured diff (stored
 * in the DB at ready-time, not re-read live, so this works even if the
 * worktree has already been cleaned up) to the real repo and commits it
 * there. Deliberately commit-only: pushing is a separate, later, explicit
 * step (pushRepoChanges) — two gates instead of one for the riskier action.
 */
export async function applyCodeChangeToRepo(diff: string, repoPath: string, commitMessage: string): Promise<void> {
  if (!diff.trim()) throw new Error('Nothing to apply — the diff is empty.');
  const patchPath = path.join(os.tmpdir(), `speako-code-change-${Date.now()}.patch`);
  fs.writeFileSync(patchPath, diff);
  try {
    await git(['apply', patchPath], repoPath);
    await git(['add', '-A'], repoPath);
    await git(['commit', '-m', commitMessage], repoPath);
  } finally {
    fs.unlinkSync(patchPath);
  }
}

/** Separate, explicit push step — never bundled into applyCodeChangeToRepo, per the "no push unless approved" requirement being its own gate distinct from "no commit unless approved." */
export async function pushRepoChanges(repoPath: string): Promise<void> {
  await git(['push'], repoPath);
}

/**
 * Discards a task without applying anything — stops the background agent
 * (best-effort; it may have already finished) and force-removes its
 * worktree. Uses `git worktree remove --force` directly rather than
 * `claude rm`, which deliberately refuses to remove a worktree with
 * uncommitted changes (confirmed via a real test) — exactly the case here,
 * since discarding *is* choosing to throw those changes away. A worktree
 * still locked by a live/just-stopped Claude session needs `--force` passed
 * twice — a single `--force` only overrides the dirty-tree check, not the
 * lock (confirmed via a real "cannot remove a locked working tree" error).
 */
export async function discardCodeChangeTask(cliSessionId: string, worktreePath: string, repoPath: string): Promise<void> {
  try {
    await execFileAsync('claude', ['stop', cliSessionId], { timeout: SPAWN_TIMEOUT_MS });
  } catch (err: any) {
    console.error(`[claudeCodeCli] stop ${cliSessionId} failed (may have already finished):`, err.message);
  }
  await git(['worktree', 'remove', '--force', '--force', worktreePath], repoPath);
}

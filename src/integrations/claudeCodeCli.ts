import { execFile } from 'child_process';
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

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
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

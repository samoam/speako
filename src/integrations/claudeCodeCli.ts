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
// `Skill` is denied, not allowed: a repo's own skills (.claude/skills/ —
// officercc ships run-integration-test) are gated by a per-directory trust
// dialog ("Claude may use instructions, code, or files from this Skill …
// don't ask again for <skill> in <dir>") that no tool allow-list covers, and
// an agent's scratch worktree is a new directory every time, so it would
// always ask (seen live, fix rounds 6 and 7 — round 7 with Skill allowed).
// Denied, the agent runs Maven/npm itself through Bash instead.
const DISALLOWED_TOOLS = ['Bash(git commit:*)', 'Bash(git push:*)', 'Skill'];

/**
 * A `--bg` agent is headless: any tool call its permission rules don't
 * cover parks it forever on a "This command requires approval" prompt
 * nobody can answer (seen live 2026-10-02: a fix agent blocked on its first
 * command, `cd … && git branch …; git fetch origin …`, and its run failed
 * with "no file changes"). `--permission-mode acceptEdits` alone was also
 * confirmed flaky for brand-new file creation (sometimes a hung "create X?"
 * prompt), hence Write/Edit listed explicitly. So every read-only git
 * command, the usual file/search commands and the build/test tools an
 * implementation needs are allowed up front; commit/push stay denied (the
 * cycle commits and pushes itself, after approval). bypassPermissions would
 * remove the problem entirely but `--bg` refuses it until the user has
 * accepted its disclaimer once interactively (confirmed live).
 */
// Plain `Bash` (every shell command) rather than per-command patterns: a
// pattern list was tried first and a compound command with pipes and a
// quoted `\|` regex still prompted (seen live, round 2 of the same fix) —
// the CLI's command matcher is conservative with shell syntax it can't
// parse safely, and an agent blocked once is a failed run. Confirmed live
// (2026-10-02, through startClaudeCodeTask): with this list the same
// compound command runs unprompted, and `git commit` is REFUSED outright by
// the deny rule below rather than prompting — the only restriction that
// actually matters inside a disposable worktree.
const ALLOWED_TOOLS = ['Write', 'Edit', 'Read', 'Grep', 'Glob', 'Bash'];

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

/**
 * Matches a Bitbucket repoSlug to one of the configured local codebases by
 * checking each one's actual git remote — codebaseLocalPaths' `name` is an
 * arbitrary label (see resolveLocalRepoPath above), not necessarily the
 * Bitbucket repo slug, so guessing by name (e.g. "only one repo is
 * configured, so it must be this one") can silently point a PR review at
 * the wrong repository — confirmed live: a review picked the sole
 * configured repo for a PR that actually belonged to a different repo in
 * the same project, and failed minutes later with a confusing "couldn't
 * find remote ref" instead of a clear "wrong repo" error. Returns null if
 * no configured repo's origin matches.
 */
export async function findLocalRepoForBitbucketRepo(repoSlug: string): Promise<string | null> {
  for (const { name, path: repoPath } of config.codebaseLocalPaths) {
    try {
      const url = (await git(['remote', 'get-url', 'origin'], repoPath, 10_000)).trim();
      const slug = url.replace(/\.git$/, '').split(/[/:]/).pop();
      if (slug && slug.toLowerCase() === repoSlug.toLowerCase()) return name;
    } catch {
      // Not a git repo, no "origin" remote, or git unavailable — just skip it.
    }
  }
  return null;
}

export interface ClaudeCodeTaskHandle {
  cliSessionId: string;
}

/**
 * `claude --help` documents that the one-time-per-directory workspace trust
 * dialog is skipped automatically for `-p`/non-interactive output (which is
 * why runClaudeCodeReview below never hits this) — but confirmed live that
 * `--bg` is NOT covered by that same skip, and Claude CLI has no
 * skip-trust flag, so a `--bg` run
 * against a freshly created worktree (always untrusted) fails outright with
 * "Workspace not trusted... run claude once and accept the trust prompt" —
 * fatal in headless mode with no TTY to answer it. Claude CLI persists
 * acceptance in `~/.claude.json`'s `projects[<path>].hasTrustDialogAccepted`,
 * keyed by the absolute path with backslashes normalized to forward slashes
 * but drive-letter case preserved as-is (confirmed live by inspecting that
 * file for paths this codebase's own os.tmpdir()-based worktrees produced,
 * already-trusted entries under `C:/Users/...` — uppercase, not lowercased)
 * — this writes that same flag directly so a background agent never hits
 * the prompt in the first place, rather than needing a human to run `claude`
 * interactively once in every fresh temp worktree Speako creates.
 */
function normalizeClaudeProjectPath(dirPath: string): string {
  return dirPath.replace(/\\/g, '/');
}

function trustClaudeWorkspace(dirPath: string): void {
  const configPath = path.join(os.homedir(), '.claude.json');
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const key = normalizeClaudeProjectPath(dirPath);
    data.projects = data.projects ?? {};
    data.projects[key] = { ...(data.projects[key] ?? {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error(`[claudeCodeCli] failed to pre-trust workspace ${dirPath} — claude --bg may hit the trust prompt:`, err.message);
  }
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
/**
 * Which subscription model an agentic run uses — picked per call site rather
 * than left to the CLI's default, so quota goes to the strongest model only
 * where judgment matters most (review, planning) and implementation work
 * runs on a cheaper tier. Omitted = CLI default.
 */
export type ClaudeAgentModel = 'opus' | 'sonnet' | 'haiku';

/**
 * `claude --bg` returns only once the session is registered, and before
 * that it may have to start the background service ("Starting background
 * service…", seen live after a server restart) and `--worktree` has to
 * `git worktree add` the repo (≈1 min for the 15k-file officercc clone). At
 * the generic 20s SPAWN_TIMEOUT_MS that combination timed out on our side
 * while the agent still started — an orphan nobody polled.
 */
const BG_SPAWN_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * `extraDirs`: directories the agent may touch beyond its launch directory.
 * `--worktree` puts the agent in <main repo>/.claude/worktrees/<name>, and
 * when the launch directory is a *linked* worktree elsewhere (a dev cycle's
 * worktree under %TEMP%), that scratch path is outside it — the agent's
 * very first `cd <own cwd> && …` then needs approval nobody can give (seen
 * live, fix round 4). Passing the main repo root here keeps it inside.
 */
export interface StartClaudeCodeTaskOptions {
  /** Directories the agent may touch beyond its launch directory (`--add-dir`). */
  extraDirs?: string[];
  /**
   * Let the CLI create a scratch worktree (`--worktree`, the default) or run
   * the agent right where it's launched. The dev cycle passes false: it
   * makes the scratch worktree itself, because `--worktree` puts the agent
   * under <main repo>/.claude/worktrees while the cycle launches from a
   * worktree under %TEMP%, and `acceptEdits` only auto-accepts edits inside
   * the launch directory — so the agent's first file edit parked it on a
   * prompt (seen live, fix round 5, even with --add-dir for the main repo).
   */
  useWorktree?: boolean;
}

/**
 * Once the user has accepted the CLI's bypass disclaimer (one interactive
 * `claude --dangerously-skip-permissions`), headless agents run with no
 * permission prompts at all — the only state in which "a prompt parked the
 * agent" can't happen. Until then `--bg` refuses that mode with this exact
 * message (confirmed live), and the launcher falls back to acceptEdits +
 * the allow-list. Remembered per process so the refusal is paid once.
 */
let bypassRefused = false;
const BYPASS_DISCLAIMER_RE = /requires accepting the disclaimer/i;

export async function startClaudeCodeTask(prompt: string, repoPath: string, model?: ClaudeAgentModel, options: StartClaudeCodeTaskOptions = {}): Promise<ClaudeCodeTaskHandle> {
  trustClaudeWorkspace(repoPath);
  const baseArgs = [
    '--bg', prompt,
    // No MCP servers (same as runClaudeCodeReview): a code-change agent only
    // needs the checked-out code and its build tool, every MCP tool call is
    // its own permission prompt — fix round 8 parked on "jenkins-acceo —
    // Jenkins Search Jobs" looking up the ticket — and without this every
    // agent also starts all of the user's configured servers (22 seen live).
    '--strict-mcp-config',
    ...(options.useWorktree === false ? [] : ['--worktree']),
    ...(options.extraDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
    // Confirmed live that --bg accepts --model (a background session
    // started and completed with it); the session listing doesn't report
    // which model actually ran.
    ...(model ? ['--model', model] : []),
    // Kept under bypass too: deny rules are what keep the agent from committing/pushing.
    '--disallowedTools', ...DISALLOWED_TOOLS,
  ];
  const launch = (permissionArgs: string[]) => execFileAsync('claude', [...baseArgs, ...permissionArgs], { cwd: repoPath, timeout: BG_SPAWN_TIMEOUT_MS });
  let stdout: string;
  try {
    if (!bypassRefused) {
      try {
        ({ stdout } = await launch(['--dangerously-skip-permissions']));
      } catch (err: any) {
        if (!BYPASS_DISCLAIMER_RE.test(String(err?.stderr || err?.stdout || err?.message || ''))) throw err;
        bypassRefused = true;
        console.warn('[claudeCodeCli] background agents run with permission prompts possible — run `claude --dangerously-skip-permissions` once interactively and accept the disclaimer to let them run unprompted.');
        ({ stdout } = await launch(['--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS]));
      }
    } else {
      ({ stdout } = await launch(['--permission-mode', 'acceptEdits', '--allowedTools', ...ALLOWED_TOOLS]));
    }
  } catch (err: any) {
    // The prompt is argv, so the raw "Command failed: claude --bg <whole prompt>…" message is useless; say what actually happened.
    const detail = err?.killed ? `did not register a session within ${BG_SPAWN_TIMEOUT_MS / 1000}s` : String(err?.stderr || err?.message || err).trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    throw new Error(`claude --bg failed to start: ${detail}`);
  }
  const match = stdout.match(/backgrounded\s*[·:]\s*(\S+)/);
  if (!match) {
    throw new Error(`Could not parse a session id from Claude Code's output: ${stdout.slice(0, 300)}`);
  }
  return { cliSessionId: match[1] };
}

/** Strips ANSI escape/control sequences (cursor moves, color codes) from `claude logs`'s output below — that command prints the background session's actual terminal output, which is meant for a real terminal, not for appending as plain-text log lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

/** `claude logs <id>` prints the background session's recent terminal output (confirmed via `claude logs --help`) — used by the Jira-implement pipeline to surface Claude's actual progress (tool calls, reasoning) in its own live log, the same way runClaudeCodeReview's onProgress does for the (streaming, foreground) review/plan path; `--bg` has no equivalent streaming callback, so this is polled instead. Returns the ANSI-stripped text; callers diff against what they've already seen to append only new lines. */
export async function getBackgroundTaskLogs(cliSessionId: string): Promise<string> {
  const { stdout } = await execFileAsync('claude', ['logs', cliSessionId], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 });
  return stripAnsi(stdout);
}

export interface ClaudeCodeAgentInfo {
  id: string;
  cwd: string;
  state: string; // e.g. 'running', 'done', 'blocked', 'stopped' — confirmed empirically, not officially enumerated by the CLI's --help
  name: string;
  /** What a 'blocked' agent is waiting on (confirmed live: "permission prompt"); null otherwise. */
  waitingFor: string | null;
}

/** `claude agents --json --all` lists every background/interactive session this machine knows about — filtered here to the one Speako started. Returns null if the CLI has since forgotten about it (e.g. after a `claude rm`). */
export async function getTaskInfo(cliSessionId: string): Promise<ClaudeCodeAgentInfo | null> {
  const { stdout } = await execFileAsync('claude', ['agents', '--json', '--all'], { timeout: SPAWN_TIMEOUT_MS });
  const agents: any[] = JSON.parse(stdout);
  const found = agents.find((a) => a.id === cliSessionId);
  // waitingFor (confirmed live: "permission prompt") says what a 'blocked' agent is stuck on.
  return found ? { id: found.id, cwd: found.cwd, state: found.state, name: found.name, waitingFor: found.waitingFor ?? null } : null;
}

/** Stops a background agent (best-effort — it may already be gone). */
export async function stopBackgroundTask(cliSessionId: string): Promise<void> {
  try {
    await execFileAsync('claude', ['stop', cliSessionId], { timeout: SPAWN_TIMEOUT_MS });
  } catch (err: any) {
    console.error(`[claudeCodeCli] stop ${cliSessionId} failed (may have already finished):`, err.message);
  }
}

/**
 * Removes the scratch worktree `--worktree` created for a background agent
 * (always under the repo's .claude/worktrees/) and its `worktree-*` branch,
 * once its diff has been captured or it failed. Seen live: seven of these
 * had accumulated in the user's repo, two of them with zombie agents still
 * parked on permission prompts. Anything that isn't such a scratch worktree
 * (e.g. the cycle's own worktree) is left alone.
 */
export async function removeAgentScratchWorktree(agentCwd: string, anyWorktreeOfRepo: string): Promise<void> {
  const normalized = agentCwd.replace(/\\/g, '/');
  const match = normalized.match(/\/\.claude\/worktrees\/([^/]+)$/);
  // The dev cycle's own scratch worktrees (addWorktreeForExistingBranch with
  // the 'agent' label) are detached checkouts under %TEMP% — no branch to delete.
  const speakoScratch = /\/speako-dev-cycle-agent-[^/]+$/.test(normalized);
  if (!match && !speakoScratch) return;
  if (speakoScratch || !match) {
    await removeWorktree(agentCwd, anyWorktreeOfRepo).catch((err: any) => console.error(`[claudeCodeCli] failed to remove agent worktree ${agentCwd}:`, err.message));
    return;
  }
  try {
    // removeWorktree retries: right after `claude stop` the agent's process
    // can still hold the directory for a moment (confirmed live: a single
    // immediate remove failed with "Permission denied" on Windows).
    await removeWorktree(agentCwd, anyWorktreeOfRepo);
  } catch (err: any) {
    // `claude stop` of a finished agent sometimes removes its own worktree
    // first (confirmed live: "is not a working tree") — that's the goal, not an error.
    if (!/is not a working tree/.test(err.message ?? '')) console.error(`[claudeCodeCli] failed to remove agent worktree ${agentCwd}:`, err.message);
  }
  await git(['branch', '-D', `worktree-${match[1]}`], anyWorktreeOfRepo).catch(() => undefined);
}

export async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    // execFile's timeout kill surfaces as a bare "Command failed: git …" with
    // empty stderr — indistinguishable from a real git failure (seen live: a
    // push that completed on the remote but took 33s was reported as failed).
    if (err?.killed) throw new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s (${args.join(' ')})`);
    throw err;
  }
}

// A real fetch + worktree checkout against a large repo (confirmed live: one
// with 15k+ tracked files) takes meaningfully longer than the 30s GIT_TIMEOUT_MS
// used for the small, targeted git calls elsewhere in this file (diff/commit/
// push all operate on an already-checked-out worktree, not a fresh full copy).
const WORKTREE_CHECKOUT_TIMEOUT_MS = 5 * 60 * 1000;

// Confirmed live against a real officercc clone with a corrupted local object
// database (git fsck showed missing trees/blobs unrelated to any specific PR
// branch): `git worktree add` fails with "unable to read tree"/"unable to
// read blob"/"unable to read sha1 file" in that case. A plain `git fetch`
// doesn't repair it — git already believes it has everything for refs it's
// already fetched — only `--refetch` forces re-downloading every object
// regardless of what's already present locally, so it's reserved for this
// repair retry rather than used on every worktree add.
const REFETCH_REPAIR_TIMEOUT_MS = 10 * 60 * 1000;

function isMissingObjectError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unable to read (tree|blob|sha1 file)/i.test(message);
}

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
  try {
    await git(['worktree', 'add', worktreePath, `origin/${branch}`], repoPath, WORKTREE_CHECKOUT_TIMEOUT_MS);
  } catch (err) {
    if (!isMissingObjectError(err)) throw err;
    await git(['fetch', 'origin', '--refetch'], repoPath, REFETCH_REPAIR_TIMEOUT_MS);
    await git(['worktree', 'add', worktreePath, `origin/${branch}`], repoPath, WORKTREE_CHECKOUT_TIMEOUT_MS);
  }
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

// 15 min was too tight in practice for the Jira-implement Plan step against
// this codebase's actual monorepo layout (officercc-common, officercc4,
// officercc4db(-gdsl/-qdsl), officercc5-service, officercc5-ai,
// officercc5-lago-proxy, poc-qa, ...) — confirmed live a real ticket's plan
// step repeatedly hit this timeout mid-investigation (dozens of distinct
// grep/find/read tool calls still running, not stuck/looping) rather than
// finishing over-budget just once.
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000; // real codebase exploration can take a while, unlike a trivial smoke-test prompt
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
  options?: { jsonSchema?: object; onProgress?: (message: string) => void; model?: ClaudeAgentModel }
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
        // No MCP servers: a review/plan/merge run only reads the checked-out
        // code with built-in tools, and Speako already supplies the Jira/
        // Confluence/Bitbucket context in the prompt. Without this every run
        // started all of the user's configured MCP servers (22 seen live).
        '--strict-mcp-config',
        '--disallowedTools', ...REVIEW_DISALLOWED_TOOLS,
        ...(options?.jsonSchema ? ['--json-schema', JSON.stringify(options.jsonSchema)] : []),
        ...(options?.model ? ['--model', options.model] : []),
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
            // Confirmed live: a real assistant turn interleaves short
            // reasoning text ("This is read-only, I'll just read the file
            // directly.") with its tool_use blocks, plus a final text block
            // with its answer — surfacing these is what makes the progress
            // log show the agent's actual chain of thought, not just which
            // tools it called. Each 'assistant' event here is already a
            // complete block (not a partial delta), despite
            // --include-partial-messages also emitting separate
            // 'stream_event' delta events this loop ignores.
            else if (block.type === 'text' && block.text?.trim()) onProgress(`Claude: ${block.text.trim().slice(0, 500)}`);
            else if (block.type === 'thinking' && block.thinking?.trim()) onProgress(`Claude (thinking): ${block.thinking.trim().slice(0, 500)}`);
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

/**
 * Separate, explicit push step — never bundled into applyCodeChangeToRepo,
 * per the "no push unless approved" requirement being its own gate distinct
 * from "no commit unless approved." Pushes the checked-out branch to the
 * same name on origin explicitly: a worktree created with
 * `worktree add -b <branch> origin/<trunk>` has trunk as its upstream, and
 * a bare `git push` (push.default simple) refuses that mismatch.
 */
export async function pushRepoChanges(repoPath: string): Promise<void> {
  // Network-bound like a fetch, not a local op: a real push of this repo took 33s, past the default 30s.
  await git(['push', '-u', 'origin', 'HEAD'], repoPath, WORKTREE_CHECKOUT_TIMEOUT_MS);
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

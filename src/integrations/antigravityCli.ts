import { spawn } from 'child_process';
import { git } from './claudeCodeCli';

/**
 * Antigravity CLI (`agy`, github.com/google-antigravity/antigravity-cli) —
 * a second headless coding-agent CLI, confirmed live to authenticate against
 * a personal Google account's Antigravity/Gemini subscription (Pro-tier
 * models available) rather than the metered `GEMINI_API_KEY` billing every
 * other Gemini call in this app uses. Used for the Jira-implement pipeline's
 * plan/implement steps and PR review's second opinion, wherever `agy` is
 * actually installed. The old `gemini` CLI path this used to fall back to
 * was removed outright (not just gated off) — it depended on
 * GEMINI_API_KEY's metered billing and was seen failing live with opaque
 * errors (e.g. exit 402) with no clear way to fix it locally; when `agy`
 * isn't available/fails, callers now just proceed without a second opinion
 * rather than trying a second fallback CLI.
 *
 * A real .exe (unlike gemini CLI's Windows `.cmd` shim — see geminiCli.ts's
 * header comment for why that one needs cross-spawn), so plain
 * `child_process.spawn('agy', ...)` resolves it correctly without cross-spawn's
 * shell workaround.
 *
 * Confirmed live (this session, against a real installed `agy` 1.2.10):
 * - `-p <prompt> --output-format json` returns one JSON object,
 *   `{conversation_id, status, response, duration_seconds, usage}` — `status`
 *   is `"SUCCESS"` on a normal completion. Unlike claudeCodeCli.ts/geminiCli.ts,
 *   this file deliberately uses the non-streaming `json` format, not
 *   `stream-json` — `stream-json`'s event shape (`{event:"init"|"step_update",
 *   step_update:{step_type, state, tool_name, tool_info, text_delta, ...}}`)
 *   was observed but its terminal/completion event was never confirmed live,
 *   so onProgress here is necessarily coarser (no per-tool-call detail) than
 *   the other two CLIs until that's verified.
 * - **Workspace trust is NOT automatic** (confirmed live, and matches
 *   antigravity-cli GitHub issue #507, an open feature request): without
 *   `--add-dir <path>`, tool calls run against `agy`'s own internal
 *   `~/.gemini/antigravity-cli/scratch` sandbox instead of the given cwd,
 *   silently — no error, just silently wrong output. `--add-dir` must always
 *   be passed with the target directory to actually operate on it.
 * - **`--mode accept-edits` does NOT block `git commit`** the way Claude
 *   Code CLI's `--disallowedTools 'Bash(git commit:*)'` does (confirmed
 *   live: a real `git commit` landed with `--dangerously-skip-permissions`
 *   set) — there is no discovered equivalent flag to deny just that one
 *   command while still running non-interactively. The safety net here is
 *   structural instead: this is only ever used inside a disposable worktree
 *   (never the user's real repo), `disableGitPush` below makes an actual
 *   `git push` fail at the transport level regardless of whether the agent
 *   attempts one, and `getWorktreeDiffSinceBase` (not a plain
 *   `git diff --cached`) still captures the real changes even if the agent
 *   committed them mid-session.
 */
const AGY_TIMEOUT_MS = 30 * 60 * 1000; // matches claudeCodeCli.ts's REVIEW_TIMEOUT_MS — Promise.all in server.ts waits for the slower of the two, so there's no point in one giving up well before the other

export interface AntigravityRunResult {
  resultText: string;
  isError: boolean;
}

let antigravityAvailable: boolean | null = null;

/** Best-effort presence check, cached for the process lifetime — a spawn ENOENT is the authoritative signal either way (see runAntigravityAgent), this just avoids a wasted spawn on every call once we already know it's missing. */
export function isAntigravityCliConfigured(): boolean {
  return antigravityAvailable !== false;
}

/**
 * Runs one headless `agy` turn against `dirPath` — read-only (`mode: 'plan'`)
 * for PR review / dev-plan generation, or write-capable (`mode: 'accept-edits'`)
 * for the Jira-implement pipeline's Implement step. Resolves with
 * `isError: true` rather than rejecting for anything that isn't a hard spawn
 * failure, so callers can degrade gracefully (skip the second opinion, or
 * fall back to the surviving implementation) instead of the whole pipeline
 * failing.
 */
export function runAntigravityAgent(
  prompt: string,
  dirPath: string,
  options: { mode: 'plan' | 'accept-edits'; onProgress?: (message: string) => void }
): Promise<AntigravityRunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'agy',
        ['-p', prompt, '--mode', options.mode, '--output-format', 'json', '--add-dir', dirPath, '--dangerously-skip-permissions'],
        { cwd: dirPath }
      );
    } catch (err: any) {
      antigravityAvailable = false;
      resolve({ resultText: err?.message ?? String(err), isError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ resultText: 'Antigravity CLI (agy) timed out.', isError: true });
    }, AGY_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      // ENOENT (agy not installed) lands here — the fallback path every call site expects.
      antigravityAvailable = false;
      options.onProgress?.(`Antigravity CLI unavailable (${err.message}).`);
      resolve({ resultText: err.message, isError: true });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      antigravityAvailable = true;
      try {
        // agy's own stdout can carry incidental non-JSON lines ahead of the
        // final result (confirmed live it doesn't in `--output-format json`
        // mode, but this is defensive against a future version that does) —
        // the actual result is a single JSON object, so take the last
        // non-empty line rather than assuming stdout is exactly one line.
        const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const parsed = JSON.parse(lines[lines.length - 1] ?? '{}');
        if (parsed.status === 'SUCCESS') {
          options.onProgress?.(parsed.response ? `Antigravity: ${String(parsed.response).slice(0, 500)}` : 'Antigravity: done.');
          resolve({ resultText: parsed.response ?? '', isError: false });
        } else {
          resolve({ resultText: parsed.response || stderr.trim() || `agy exited with code ${code}`, isError: true });
        }
      } catch {
        resolve({ resultText: stderr.trim() || stdout.trim() || `agy exited with code ${code}`, isError: true });
      }
    });

    child.stdin?.end();
  });
}

/**
 * Read-only second-opinion review/plan call via `agy` (subscription billing,
 * see this file's header) — the one call site both PR review and the
 * Jira-implement pipeline's Plan step use, since both just need "an
 * independent second AI's read-only take on this prompt, as free text,"
 * nothing write-capable. No `gemini`-CLI fallback: when `agy` isn't
 * installed or fails, this just resolves isError:true and the caller
 * proceeds with the Claude-only result (see each call site in server.ts).
 */
export async function runSecondOpinionReview(
  prompt: string,
  dirPath: string,
  onProgress?: (message: string) => void
): Promise<AntigravityRunResult> {
  if (!isAntigravityCliConfigured()) {
    return { resultText: 'Antigravity CLI (agy) is not installed.', isError: true };
  }
  return runAntigravityAgent(prompt, dirPath, { mode: 'plan', onProgress });
}

/**
 * Structural defense against an unauthorized `git push` from inside a
 * disposable worktree (see this file's header comment) — breaks the
 * worktree's push URL so `git push` fails at the transport level regardless
 * of whether `agy` itself would have tried one. `git pull`/`fetch` (which
 * use the read `url`, untouched) still work; only pushing is disabled.
 */
export async function disableGitPush(worktreePath: string): Promise<void> {
  await git(['remote', 'set-url', '--push', 'origin', 'disabled-by-speako://no-push'], worktreePath);
}

/**
 * Diffs the CURRENT full state of `worktreePath` (staged via `git add -A`,
 * covering both committed-since-base and still-uncommitted changes) against
 * `baseRef` — deliberately not `getWorktreeDiff`'s plain `git diff --cached`
 * (index vs HEAD), which would come back empty if the agent committed its
 * own changes mid-session (index vs HEAD is clean right after a commit, even
 * though real changes exist relative to where the branch started).
 */
export async function getWorktreeDiffSinceBase(worktreePath: string, baseRef: string): Promise<string> {
  await git(['add', '-A'], worktreePath);
  return git(['diff', '--cached', baseRef], worktreePath);
}

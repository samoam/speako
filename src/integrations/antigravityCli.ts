import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
 * A real .exe (not a Windows `.cmd` shim), so plain `child_process.spawn`
 * resolves it without a shell wrapper.
 *
 * Confirmed live (this session, against a real installed `agy` 1.2.10):
 * - Every turn now goes through runAgyTurn below (prompt on stdin via
 *   `--input-format stream-json`, confirmed live against agy 1.2.14); its
 *   final `{event:"result", result:{status, response, ...}}` line carries the
 *   same fields `-p <prompt> --output-format json` used to return, `status`
 *   `"SUCCESS"` on a normal completion. The intermediate `step_update` events
 *   aren't parsed yet, so onProgress stays coarser than the Claude CLI's.
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
 *   (never the user's real repo), NO_PUSH_GIT_ENV below makes an actual
 *   `git push` fail at the transport level for every git the agent process
 *   spawns, and `getWorktreeDiffSinceBase` (not a plain `git diff --cached`)
 *   still captures the real changes even if the agent committed them
 *   mid-session. The push block is an environment override, never a config
 *   write: an earlier version ran `git remote set-url --push` in the
 *   worktree, and since worktrees share the repo's .git/config that
 *   disabled pushing for the developer's own checkout too (seen live
 *   2026-10-02 — the dev cycle's own push step then failed on it).
 */
const AGY_TIMEOUT_MS = 30 * 60 * 1000; // matches claudeCodeCli.ts's REVIEW_TIMEOUT_MS — Promise.all in server.ts waits for the slower of the two, so there's no point in one giving up well before the other

export interface AntigravityRunResult {
  resultText: string;
  isError: boolean;
}

let antigravityAvailable: boolean | null = null;

/**
 * `agy`'s own installer puts the binary at %LOCALAPPDATA%\agy\bin\agy.exe and
 * leaves PATH to a separate `agy install` step — confirmed on this dev
 * machine, where that step never ran, so a bare spawn('agy') ENOENT'd and
 * silently disabled every second opinion. Falls back to the bare name (PATH).
 */
export function resolveAgyBinary(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const installed = path.join(localAppData, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(installed)) return installed;
  }
  return 'agy';
}

export interface AgyTurnOutcome {
  /** The final `{"event":"result","result":{...}}` payload, or null if agy never produced one. */
  result: any | null;
  stderr: string;
  code: number | null;
  spawnError?: Error;
}

/**
 * One headless agy turn with the prompt on stdin instead of argv — argv caps
 * out around 32k chars on Windows, well under a real PR-review prompt with a
 * Jira ticket and Confluence pages inlined. Confirmed live (agy 1.2.14):
 * plain-text stdin isn't read; `--input-format stream-json` (which requires
 * `--output-format stream-json`) reads one `{"event":"user","message":{"role":
 * "user","content":"..."}}` line, and `--print=` must come last with an empty
 * value (a bare `-p` swallows the next flag as its prompt). The last stdout
 * line is `{"event":"result","result":{status, response, structured_output?,
 * usage}}`; `--json-schema` fills `structured_output`.
 */
export function runAgyTurn(prompt: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<AgyTurnOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveAgyBinary(), ['--input-format', 'stream-json', '--output-format', 'stream-json', ...args, '--print='], { cwd, env: { ...process.env, ...env } });
    } catch (err: any) {
      resolve({ result: null, stderr: '', code: null, spawnError: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: AgyTurnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ result: { status: 'ERROR', response: 'Antigravity CLI (agy) timed out.' }, stderr, code: null });
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (err: any) => finish({ result: null, stderr, code: null, spawnError: err }));
    child.on('close', (code) => {
      let result: any = null;
      for (const line of stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'result') result = event.result;
        } catch {
          // incidental non-JSON output — only the result event matters
        }
      }
      finish({ result, stderr, code });
    });
    child.stdin?.write(`${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`);
    child.stdin?.end();
  });
}

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
export async function runAntigravityAgent(
  prompt: string,
  dirPath: string,
  options: { mode: 'plan' | 'accept-edits'; onProgress?: (message: string) => void }
): Promise<AntigravityRunResult> {
  const outcome = await runAgyTurn(prompt, ['--mode', options.mode, '--add-dir', dirPath, '--dangerously-skip-permissions'], dirPath, AGY_TIMEOUT_MS, options.mode === 'accept-edits' ? NO_PUSH_GIT_ENV : {});
  if (outcome.spawnError) {
    // ENOENT (agy not installed) lands here — the fallback path every call site expects.
    antigravityAvailable = false;
    options.onProgress?.(`Antigravity CLI unavailable (${outcome.spawnError.message}).`);
    return { resultText: outcome.spawnError.message, isError: true };
  }
  antigravityAvailable = true;
  const result = outcome.result;
  if (result?.status === 'SUCCESS') {
    options.onProgress?.(result.response ? `Antigravity: ${String(result.response).slice(0, 500)}` : 'Antigravity: done.');
    return { resultText: result.response ?? '', isError: false };
  }
  return { resultText: result?.error || result?.response || outcome.stderr.trim() || `agy exited with code ${outcome.code}`, isError: true };
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

/** The push URL an earlier Speako version wrote into the shared repo config (see the header) — recognized so the dev cycle's push step can remove it if it's still there. */
export const LEGACY_NO_PUSH_URL = 'disabled-by-speako://no-push';

/**
 * Structural defense against an unauthorized `git push` from inside a
 * disposable worktree (see this file's header comment): git ≥ 2.31 reads
 * GIT_CONFIG_COUNT/KEY_n/VALUE_n as config for that process only, so every
 * git the agent spawns sees a broken push URL while the repo's own config —
 * shared by every worktree and the developer's checkout — is untouched.
 * `git pull`/`fetch` (the read `url`) still work; only pushing is disabled.
 */
export const NO_PUSH_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
  GIT_CONFIG_VALUE_0: LEGACY_NO_PUSH_URL,
};

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

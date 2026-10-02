import { getTaskInfo, getWorktreeDiff, stopBackgroundTask, removeAgentScratchWorktree } from './claudeCodeCli';
import { getCodeChangeRequest, appendCodeChangeLog, markCodeChangeReady, markCodeChangeFailed } from '../storage/codeChangeRequestRepository';

/**
 * Polls a background Claude Code agent until it settles, then captures its
 * diff. Extracted out of InterfaceServer (where this originally lived as a
 * private method) so a draft kind's execute() (src/drafts/kinds/jenkinsFixDraft.ts)
 * can kick off the same polling loop that action-item/task-triggered code
 * changes already use, without needing access to the server instance itself
 * — takes a plain broadcast callback instead, same convention as draftService.ts.
 *
 * `claude agents --json` (getTaskInfo) only ever reports a coarse state, not
 * a transcript, so unlike runClaudeCodeReview's token-level onProgress there
 * is no real per-tool-call detail to surface here — instead this synthesizes
 * a "still working" heartbeat plus state-change lines, persisted via
 * appendCodeChangeLog (mirrors pr_review_requests.log) and broadcast as
 * 'code-change-log' so the task detail view's log panel updates live the
 * same way the PR review log does.
 */
export async function pollCodeChangeRequest(requestId: number, broadcast: (event: Record<string, unknown>) => void): Promise<void> {
  const POLL_INTERVAL_MS = 10_000;
  const MAX_ATTEMPTS = 120; // 20 minutes
  const FAILURE_STATES = ['stopped', 'failed', 'error'];

  const request = getCodeChangeRequest(requestId);
  if (!request) return;

  const log = (message: string) => {
    appendCodeChangeLog(requestId, message);
    broadcast({ type: 'code-change-log', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, message });
  };
  log(`Starting Claude Code agent (session ${request.cliSessionId})…`);

  let lastState: string | null = null;
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let info;
    try {
      info = await getTaskInfo(request.cliSessionId);
    } catch (err: any) {
      // err.stderr (present on a non-zero exit from execFile) usually has
      // the actual reason — err.message alone is often just "Command
      // failed: claude agents --json --all" with nothing actionable.
      const detail = err?.stderr ? `${err.message}\n${String(err.stderr).trim()}` : err?.message ?? String(err);
      console.error(`[claude-code] status check failed for request ${requestId}:`, detail);
      consecutiveFailures++;
      // Surfaced to the UI log too (not just the server console) so a
      // stuck "Running…" isn't silent — but throttled to the first
      // occurrence and then once per ~minute, same cadence as the
      // "still working" heartbeat below, so a fast-repeating failure
      // doesn't flood the log.
      if (consecutiveFailures === 1 || consecutiveFailures % 6 === 0) {
        log(`Status check failed (will retry): ${detail}`);
      }
      continue; // transient CLI hiccup — keep trying rather than failing the whole task on one bad poll
    }
    consecutiveFailures = 0;
    if (!info) continue; // not registered yet, or briefly missing — keep polling

    if (info.state !== lastState) {
      log(`Agent state: ${info.state}`);
      lastState = info.state;
    } else if (attempt > 0 && attempt % 6 === 0) {
      // Every ~minute of no state change, so the log shows the agent is
      // still alive rather than going silent for up to 20 minutes.
      log(`Still working… (${Math.round(((attempt + 1) * POLL_INTERVAL_MS) / 60_000)}m elapsed)`);
    }

    if (info.state === 'blocked') {
      // Headless, so nobody will ever answer — seen live: an agent parked on
      // a "This command requires approval" prompt for hours, its half-done
      // work read as "finished". Stop it and fail with what it wanted.
      const error = `Claude Code agent is stuck on ${info.waitingFor ? `a ${info.waitingFor}` : 'a prompt'} it cannot answer headlessly — check \`claude logs ${request.cliSessionId}\` for the command; see claudeCodeCli.ts's ALLOWED_TOOLS.`;
      log(error);
      await stopBackgroundTask(request.cliSessionId);
      await removeAgentScratchWorktree(info.cwd, request.repoPath);
      markCodeChangeFailed(requestId, error);
      broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error });
      return;
    }
    if (info.state === 'done') {
      try {
        const diff = await getWorktreeDiff(info.cwd);
        if (!diff.trim()) {
          const error = `Claude Code agent finished with no file changes — check \`claude logs ${request.cliSessionId}\` for what it concluded.`;
          log(error);
          markCodeChangeFailed(requestId, error);
          broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error });
        } else {
          log('Agent finished — changes captured, ready for review.');
          markCodeChangeReady(requestId, info.cwd, diff);
          broadcast({ type: 'code-change-ready', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId });
        }
      } catch (err: any) {
        log(`Failed to capture diff: ${err.message}`);
        markCodeChangeFailed(requestId, err.message);
        broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error: err.message });
      }
      // The diff is in the DB now; the agent's scratch worktree has served its purpose.
      await removeAgentScratchWorktree(info.cwd, request.repoPath);
      return;
    }
    if (FAILURE_STATES.includes(info.state)) {
      const error = `Claude Code agent ended in state "${info.state}" — check \`claude logs ${request.cliSessionId}\` for details.`;
      log(error);
      await removeAgentScratchWorktree(info.cwd, request.repoPath);
      markCodeChangeFailed(requestId, error);
      broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error });
      return;
    }
    // else: still running (or an unrecognized-but-non-terminal status) — keep polling
  }

  const timeoutError = 'Timed out waiting for the Claude Code agent after 20 minutes.';
  log(timeoutError);
  markCodeChangeFailed(requestId, timeoutError);
  broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error: timeoutError });
}

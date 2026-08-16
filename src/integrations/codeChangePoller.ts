import { getTaskInfo, getWorktreeDiff } from './claudeCodeCli';
import { getCodeChangeRequest, markCodeChangeReady, markCodeChangeFailed } from '../storage/codeChangeRequestRepository';

/**
 * Polls a background Claude Code agent until it settles, then captures its
 * diff. Extracted out of InterfaceServer (where this originally lived as a
 * private method) so a draft kind's execute() (src/drafts/kinds/devPlanDraft.ts)
 * can kick off the same polling loop that action-item/task-triggered code
 * changes already use, without needing access to the server instance itself
 * — takes a plain broadcast callback instead, same convention as draftService.ts.
 */
export async function pollCodeChangeRequest(requestId: number, broadcast: (event: Record<string, unknown>) => void): Promise<void> {
  const POLL_INTERVAL_MS = 10_000;
  const MAX_ATTEMPTS = 120; // 20 minutes
  const MAYBE_DONE_STATES = ['done', 'blocked'];
  const FAILURE_STATES = ['stopped', 'failed', 'error'];

  const request = getCodeChangeRequest(requestId);
  if (!request) return;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    let info;
    try {
      info = await getTaskInfo(request.cliSessionId);
    } catch (err: any) {
      console.error(`[claude-code] status check failed for request ${requestId}:`, err.message);
      continue; // transient CLI hiccup — keep trying rather than failing the whole task on one bad poll
    }
    if (!info) continue; // not registered yet, or briefly missing — keep polling

    if (MAYBE_DONE_STATES.includes(info.state)) {
      try {
        const diff = await getWorktreeDiff(info.cwd);
        if (!diff.trim()) {
          const error = `Claude Code agent ended in state "${info.state}" with no file changes — check \`claude logs ${request.cliSessionId}\` for details.`;
          markCodeChangeFailed(requestId, error);
          broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error });
          return;
        }
        markCodeChangeReady(requestId, info.cwd, diff);
        broadcast({ type: 'code-change-ready', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId });
      } catch (err: any) {
        markCodeChangeFailed(requestId, err.message);
        broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error: err.message });
      }
      return;
    }
    if (FAILURE_STATES.includes(info.state)) {
      const error = `Claude Code agent ended in state "${info.state}" — check \`claude logs ${request.cliSessionId}\` for details.`;
      markCodeChangeFailed(requestId, error);
      broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error });
      return;
    }
    // else: still running (or an unrecognized-but-non-terminal status) — keep polling
  }

  const timeoutError = 'Timed out waiting for the Claude Code agent after 20 minutes.';
  markCodeChangeFailed(requestId, timeoutError);
  broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, taskId: request.taskId, devCycleId: request.devCycleId, requestId, error: timeoutError });
}

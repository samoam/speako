import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import { pollCodeChangeRequest } from '../src/integrations/codeChangePoller';
import { createCodeChangeRequest, getCodeChangeRequest } from '../src/storage/codeChangeRequestRepository';

// Each poll iteration starts with a 10s sleep (POLL_INTERVAL_MS), so these
// tests take ~10s each — the price of exercising the real loop rather than a
// copy of its logic.

test('pollCodeChangeRequest: an agent blocked on a permission prompt is stopped, its scratch worktree removed, and the request failed with the reason', { timeout: 30_000 }, async (t) => {
  const request = createCodeChangeRequest({ origin: 'jenkins_fix', repoName: 'r', repoPath: 'C:\\cycle-wt', cliSessionId: 'blocked-1' });
  mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'blocked-1', cwd: 'C:\\repo\\.claude\\worktrees\\sleepy-fox', state: 'blocked', name: 'x', waitingFor: 'permission prompt' }));
  const stop = mock.method(claudeCodeCliModule, 'stopBackgroundTask', async () => {});
  const remove = mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});
  const diff = mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => 'diff --git a/x b/x');
  t.after(() => mock.restoreAll());

  const events: any[] = [];
  await pollCodeChangeRequest(request.id, (e) => events.push(e));

  const after = getCodeChangeRequest(request.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error ?? '', /stuck on a permission prompt it cannot answer headlessly/);
  assert.equal(stop.mock.callCount(), 1, 'the zombie agent is stopped');
  assert.deepEqual(remove.mock.calls[0].arguments, ['C:\\repo\\.claude\\worktrees\\sleepy-fox', 'C:\\cycle-wt']);
  assert.equal(diff.mock.callCount(), 0, 'a blocked agent\'s half-done tree is never captured as a result');
  assert.ok(events.some((e) => e.type === 'code-change-failed'));
});

test('pollCodeChangeRequest: a finished agent has its diff captured and its scratch worktree removed', { timeout: 30_000 }, async (t) => {
  const request = createCodeChangeRequest({ origin: 'dev_cycle_implement', repoName: 'r', repoPath: 'C:\\cycle-wt', cliSessionId: 'done-1' });
  mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'done-1', cwd: 'C:\\repo\\.claude\\worktrees\\busy-owl', state: 'done', name: 'x', waitingFor: null }));
  mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => 'diff --git a/y b/y\n+1');
  const remove = mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});
  t.after(() => mock.restoreAll());

  await pollCodeChangeRequest(request.id, () => {});
  const after = getCodeChangeRequest(request.id)!;
  assert.equal(after.status, 'ready');
  assert.equal(after.diff, 'diff --git a/y b/y\n+1');
  assert.equal(after.worktreePath, 'C:\\repo\\.claude\\worktrees\\busy-owl');
  assert.equal(remove.mock.callCount(), 1);
});

test('pollCodeChangeRequest: an agent that ended its turn (blocked, nothing awaited) is finished — its diff is captured and it is stopped', { timeout: 30_000 }, async (t) => {
  const request = createCodeChangeRequest({ origin: 'jenkins_fix', repoName: 'r', repoPath: 'C:\cycle-wt', cliSessionId: 'idle-1' });
  mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'idle-1', cwd: 'C:\tmp\speako-dev-cycle-agent-x', state: 'blocked', name: 'x', waitingFor: null }));
  mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => 'diff --git a/z b/z\n+fix');
  const stop = mock.method(claudeCodeCliModule, 'stopBackgroundTask', async () => {});
  mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});
  t.after(() => mock.restoreAll());

  await pollCodeChangeRequest(request.id, () => {});
  const after = getCodeChangeRequest(request.id)!;
  assert.equal(after.status, 'ready');
  assert.equal(after.diff, 'diff --git a/z b/z\n+fix');
  assert.equal(stop.mock.callCount(), 1, 'an idle agent is stopped once its diff is captured');
});

test('pollCodeChangeRequest: a finished agent with no changes fails with what it concluded', { timeout: 30_000 }, async (t) => {
  const request = createCodeChangeRequest({ origin: 'jenkins_fix', repoName: 'r', repoPath: 'C:\cycle-wt', cliSessionId: 'idle-2' });
  mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'idle-2', cwd: 'C:\tmp\speako-dev-cycle-agent-y', state: 'blocked', name: 'y', waitingFor: null }));
  mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => '');
  mock.method(claudeCodeCliModule, 'getBackgroundTaskLogs', async () => '● Running 2 shell commands…\n● I cannot fix this safely without the surefire output.\nSend me the output for those tests.\n✻ Worked for 1m · done 2:39 AM\n');
  mock.method(claudeCodeCliModule, 'stopBackgroundTask', async () => {});
  mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});
  t.after(() => mock.restoreAll());

  await pollCodeChangeRequest(request.id, () => {});
  const after = getCodeChangeRequest(request.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error ?? '', /finished with no file changes — it concluded: I cannot fix this safely without the surefire output\. Send me the output for those tests\./);
});

test('pollCodeChangeRequest: an agent still working at the time limit is stopped and the changes it made so far are kept', { timeout: 30_000 }, async (t) => {
  const request = createCodeChangeRequest({ origin: 'dev_cycle_implement', repoName: 'r', repoPath: 'C:\cycle-wt', cliSessionId: 'slow-1' });
  mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'slow-1', cwd: 'C:\tmp\speako-dev-cycle-agent-slow', state: 'working', name: 'x', waitingFor: null }));
  mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => 'diff --git a/w b/w\n+partial');
  const stop = mock.method(claudeCodeCliModule, 'stopBackgroundTask', async () => {});
  const remove = mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});
  t.after(() => mock.restoreAll());

  const events: any[] = [];
  await pollCodeChangeRequest(request.id, (e) => events.push(e), { maxWaitMs: 10_000 });
  const after = getCodeChangeRequest(request.id)!;
  assert.equal(after.status, 'ready');
  assert.equal(after.diff, 'diff --git a/w b/w\n+partial');
  assert.equal(stop.mock.callCount(), 1, 'no orphan agent is left running');
  assert.equal(remove.mock.callCount(), 1);
  assert.ok(after.log.some((l: string) => /Stopped the Claude Code agent at the 0-minute limit/.test(l)));
  assert.ok(events.some((e) => e.type === 'code-change-ready'));
});

test('pollCodeChangeRequest: an agent still working at the time limit with nothing changed fails with the timeout', { timeout: 30_000 }, async (t) => {
  const request = createCodeChangeRequest({ origin: 'dev_cycle_implement', repoName: 'r', repoPath: 'C:\cycle-wt', cliSessionId: 'slow-2' });
  mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'slow-2', cwd: 'C:\tmp\speako-dev-cycle-agent-slow2', state: 'working', name: 'x', waitingFor: null }));
  mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => '');
  mock.method(claudeCodeCliModule, 'stopBackgroundTask', async () => {});
  mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});
  t.after(() => mock.restoreAll());

  await pollCodeChangeRequest(request.id, () => {}, { maxWaitMs: 10_000 });
  const after = getCodeChangeRequest(request.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error ?? '', /Timed out waiting for the Claude Code agent after 0 minutes/);
});

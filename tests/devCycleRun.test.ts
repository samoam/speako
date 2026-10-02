import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle, setDevCyclePlans, setDevCycleBranch } from '../src/storage/devCycleRepository';
import { getRun, getRunApprovedSteps, Run } from '../src/storage/runRepository';
import { setRunBroadcast } from '../src/orchestration/engine';
import {
  devCycleRunDefinition,
  devCycleStepsThrough,
  startDevCycleRun,
  getLatestDevCycleRun,
  isDevCycleAwaitingPlanApproval,
  approveDevCycleGate,
  logDevCycle,
  devCycleView,
  isClaudeTuiNoise,
  devCycleCommitMessage,
} from '../src/orchestration/kinds/devCycleRun';

setRunBroadcast(() => {});

const plan = { understanding: 'u', approach: 'a', files: [], tests: [], risks: [], openQuestions: [], estimatedSize: 's' as const };

async function waitForStatus(runId: number, statuses: string[], timeoutMs = 5000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getRun(runId)!;
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} still "${getRun(runId)!.status}" after ${timeoutMs}ms`);
}

test('step list: analyze → plan → [approve plan] branch_and_worktrees → implement → merge_and_review → [approve diff] apply_and_push → build_and_test', () => {
  const steps = devCycleRunDefinition.steps({ cycleId: 1 }).flat();
  assert.deepEqual(steps.map((s) => s.key), ['analyze', 'plan', 'branch_and_worktrees', 'implement', 'merge_and_review', 'apply_and_push', 'build_and_test']);
  assert.deepEqual(steps.filter((s) => s.approval).map((s) => s.key), ['branch_and_worktrees', 'apply_and_push'], 'the plan approval and the merged-diff approval are the two human gates');
  assert.ok(steps.every((s) => !s.optional), 'every step is required — a failure stops the run so the user can retry');
});

test('devCycleStepsThrough: the steps a resume keeps, in pipeline order', () => {
  assert.deepEqual(devCycleStepsThrough('analyze'), ['analyze']);
  assert.deepEqual(devCycleStepsThrough('branch_and_worktrees'), ['analyze', 'plan', 'branch_and_worktrees']);
  assert.deepEqual(devCycleStepsThrough('implement'), ['analyze', 'plan', 'branch_and_worktrees', 'implement']);
  assert.deepEqual(devCycleStepsThrough('apply_and_push').at(-1), 'apply_and_push');
});

test('startDevCycleRun with a resume past the plan: kept steps start done and the plan approval is implied, so the run does not park for approval again', async () => {
  const cycle = createDevCycle({ ticketKey: 'RUN-1', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCyclePlans(cycle.id, { claude: plan });
  const run = await startDevCycleRun(cycle.id, { completedThrough: 'implement' });
  assert.deepEqual(run.steps.map((s) => [s.key, s.status]), [['analyze', 'done'], ['plan', 'done'], ['branch_and_worktrees', 'done'], ['implement', 'done'], ['merge_and_review', 'pending'], ['apply_and_push', 'pending'], ['build_and_test', 'pending']]);
  assert.deepEqual(getRunApprovedSteps(run.id), ['branch_and_worktrees']);
  // No worktree on this cycle, so merge_and_review fails fast — the point is that it *ran* instead of waiting for approval.
  const finished = await waitForStatus(run.id, ['done', 'failed', 'waiting_approval']);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error ?? '', /no worktree/);
  assert.equal(isDevCycleAwaitingPlanApproval(cycle.id), false);
  assert.equal(getLatestDevCycleRun(cycle.id)?.id, run.id);
});

test('startDevCycleRun: a second start cancels a run still in flight for the same cycle', async () => {
  const cycle = createDevCycle({ ticketKey: 'RUN-2', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCyclePlans(cycle.id, { claude: plan });
  // Resuming through 'plan' parks the run at the branch approval — a durable "in flight" state that needs no agent mocked.
  const first = await startDevCycleRun(cycle.id, { completedThrough: 'plan' });
  await waitForStatus(first.id, ['waiting_approval']);
  assert.equal(isDevCycleAwaitingPlanApproval(cycle.id), true);
  const second = await startDevCycleRun(cycle.id, { completedThrough: 'plan' });
  assert.equal(getRun(first.id)!.status, 'cancelled');
  assert.equal(getLatestDevCycleRun(cycle.id)?.id, second.id);
  await waitForStatus(second.id, ['waiting_approval']);
});

test("approveDevCycleGate / logDevCycle / devCycleView act on the cycle's latest run", async () => {
  const cycle = createDevCycle({ ticketKey: 'RUN-3', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  assert.equal(approveDevCycleGate(cycle.id), false, 'no run yet');
  assert.deepEqual(devCycleView(cycle).phases, [], 'a cycle without a run keeps its own (empty) columns');
  const run = await startDevCycleRun(cycle.id, { completedThrough: 'plan' });
  await waitForStatus(run.id, ['waiting_approval']);
  logDevCycle(cycle.id, 'Plan refined per feedback: tighten it');
  const view = devCycleView(getDevCycle(cycle.id)!);
  assert.deepEqual(view.phases.map((p) => p.status), ['done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(view.phases[2].detail, 'Waiting for your approval.');
  assert.match(view.log.at(-1) ?? '', /Plan refined per feedback: tighten it$/);
  assert.equal(approveDevCycleGate(cycle.id), true);
  // branch_and_worktrees now runs for real and fails (no Jira/git repo here) — what matters is that the approval resumed it.
  const finished = await waitForStatus(run.id, ['done', 'failed'], 30000);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.steps[2].status, 'failed');
  assert.equal(approveDevCycleGate(cycle.id), false, 'nothing left to approve');
});

// ---- build_and_test step, run in isolation with the Jenkins MCP client mocked ----

import { mock } from 'node:test';
import { updateSettings } from '../src/settingsStore';
import * as jenkinsMcpModule from '../src/integrations/jenkinsMcp';
import { getJenkinsBuildRequestsForCycle } from '../src/storage/jenkinsBuildRequestRepository';
import { StepContext } from '../src/orchestration/types';
import * as jenkinsClientModule from '../src/integrations/jenkinsClient';
import { DevCycleRunState } from '../src/orchestration/kinds/devCycleRun';

function buildStep() {
  return devCycleRunDefinition.steps({ cycleId: 0 }).flat().find((s) => s.key === 'build_and_test')!;
}

function stepContext(cycleId: number): StepContext<DevCycleRunState> & { logs: string[]; details: string[] } {
  const logs: string[] = [];
  const details: string[] = [];
  return { runId: 0, state: { cycleId }, log: (m) => logs.push(m), detail: (m) => details.push(m), signal: new AbortController().signal, logs, details };
}

test('build_and_test: skipped (not failed) when no build & test job is configured', async () => {
  const cycle = createDevCycle({ ticketKey: 'RUN-4', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  const detail = await buildStep().run(stepContext(cycle.id));
  assert.match(String(detail), /^Skipped — no build & test job configured/);
});

test('build_and_test: triggers the configured job with the branch parameter, records the request, follows queue → build, passes on SUCCESS', async (t) => {
  updateSettings({ jenkinsTestJob: 'Integration-Test', jenkinsTestBranchParam: 'BRANCH' });
  t.after(() => updateSettings({ jenkinsTestJob: '', jenkinsTestBranchParam: '' }));
  const cycle = createDevCycle({ ticketKey: 'RUN-5', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCycleBranch(cycle.id, { branchName: 'feature/RUN-5-x', worktreePath: 'wt' });

  const trigger = mock.method(jenkinsMcpModule, 'triggerJenkinsBuild', async (job: string, params: Record<string, string>) => {
    assert.equal(job, 'Integration-Test');
    assert.deepEqual(params, { BRANCH: 'feature/RUN-5-x' });
    return 26315;
  });
  mock.method(jenkinsMcpModule, 'getQueueState', async () => ({ state: 'started' as const, buildNumber: 167 }));
  mock.method(jenkinsMcpModule, 'getBuildByNumber', async () => ({ jobPath: 'job/Integration-Test', number: 167, result: 'SUCCESS', building: false, timestamp: 1, durationMs: 1, url: 'https://jenkins/167/', displayName: '#167' }));
  t.after(() => mock.restoreAll());

  const ctx = stepContext(cycle.id);
  const detail = await buildStep().run(ctx);
  assert.equal(detail, 'Build #167 passed.');
  assert.equal(trigger.mock.callCount(), 1);
  const requests = getJenkinsBuildRequestsForCycle(cycle.id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].queueId, 26315);
  assert.equal(requests[0].jobFullName, 'Integration-Test');
  assert.ok(ctx.logs.some((l) => /Build #167 started/.test(l)));
});

test('build_and_test: a FAILURE/UNSTABLE build fails the step with the build URL', async (t) => {
  updateSettings({ jenkinsTestJob: 'Integration-Test' });
  t.after(() => updateSettings({ jenkinsTestJob: '' }));
  const cycle = createDevCycle({ ticketKey: 'RUN-6', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCycleBranch(cycle.id, { branchName: 'feature/RUN-6-x', worktreePath: 'wt' });
  mock.method(jenkinsMcpModule, 'triggerJenkinsBuild', async () => 1);
  mock.method(jenkinsMcpModule, 'getQueueState', async () => ({ state: 'started' as const, buildNumber: 9 }));
  mock.method(jenkinsMcpModule, 'getBuildByNumber', async () => ({ jobPath: 'job/Integration-Test', number: 9, result: 'UNSTABLE', building: false, timestamp: 1, durationMs: 1, url: 'https://jenkins/9/', displayName: '#9' }));
  mock.method(jenkinsClientModule, 'getRecentBuilds', async () => []);
  mock.method(jenkinsClientModule, 'getTestReport', async () => ({ total: 10, failCount: 1, skipCount: 0, failures: [{ className: 'a.T', name: 'n', errorDetails: null, errorStackTrace: null, age: 1 }] }));
  t.after(() => mock.restoreAll());
  await assert.rejects(buildStep().run(stepContext(cycle.id)), /Build #9 UNSTABLE — 1 new test failure\(s\): a\.T\.n — https:\/\/jenkins\/9\//);
});

test('build_and_test: an UNSTABLE build whose failures were all already failing on the job passes (the shared job\'s baseline is unstable)', async (t) => {
  updateSettings({ jenkinsTestJob: 'Integration-Test' });
  t.after(() => updateSettings({ jenkinsTestJob: '' }));
  const cycle = createDevCycle({ ticketKey: 'RUN-7', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCycleBranch(cycle.id, { branchName: 'feature/RUN-7-x', worktreePath: 'wt' });
  mock.method(jenkinsMcpModule, 'triggerJenkinsBuild', async () => 1);
  mock.method(jenkinsMcpModule, 'getQueueState', async () => ({ state: 'started' as const, buildNumber: 10 }));
  mock.method(jenkinsMcpModule, 'getBuildByNumber', async () => ({ jobPath: 'job/Integration-Test', number: 10, result: 'UNSTABLE', building: false, timestamp: 1, durationMs: 1, url: 'https://jenkins/10/', displayName: '#10' }));
  mock.method(jenkinsClientModule, 'getRecentBuilds', async () => [{ jobPath: 'job/Integration-Test', number: 9, result: 'UNSTABLE', building: false, timestamp: 1, durationMs: 1, url: '', displayName: '#9' }]);
  mock.method(jenkinsClientModule, 'getTestReport', async () => ({ total: 10, failCount: 2, skipCount: 0, failures: [{ className: 'a.Old', name: 'one', errorDetails: null, errorStackTrace: null, age: 3 }, { className: 'a.Old', name: 'two', errorDetails: null, errorStackTrace: null, age: 1 }] }));
  t.after(() => mock.restoreAll());
  const ctx = stepContext(cycle.id);
  const detail = await buildStep().run(ctx);
  assert.match(String(detail), /^Build #10 unstable — 2 pre-existing failure\(s\), none new\.$/);
  assert.ok(ctx.logs.some((l) => /Pre-existing failures.*a\.Old\.one, a\.Old\.two/.test(l)));
});

test('isClaudeTuiNoise: drops spinner, rule and status-bar lines from `claude logs`, keeps real progress', async () => {
  for (const noise of [
    '✽ Imagining… (18s · ↓ 464 tokens · thinking with high effort)',
    '────────────────────────────────────────────── jira escalation delay implementation ─❯',
    '⏵⏵ accept edits on (shift+tab to cycle) · ← for agents · esc to interrupt',
    '───────────',
  ]) assert.equal(isClaudeTuiNoise(noise), true, noise);
  for (const real of ['Reading src/Foo.java', 'Edited LprEventPendingTicketServiceImpl.java (+12 −3)', 'The fix is already committed, so I will add the null fallback.']) assert.equal(isClaudeTuiNoise(real), false, real);
});

// ---- apply_and_push step: resumable after a failed push, and heals the legacy push block ----

import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import { createCodeChangeRequest, markCodeChangeReady, markCodeChangeApplied, markCodeChangePushed, getCodeChangeRequest } from '../src/storage/codeChangeRequestRepository';
import { LEGACY_NO_PUSH_URL } from '../src/integrations/antigravityCli';

function applyStep() {
  return devCycleRunDefinition.steps({ cycleId: 0 }).flat().find((s) => s.key === 'apply_and_push')!;
}

test('apply_and_push: a diff already committed by a previous attempt is not re-applied — only pushed; a leftover legacy push block is removed first', async (t) => {
  const cycle = createDevCycle({ ticketKey: 'RUN-8', repoName: 'r', repoPath: 'C:\repo', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCycleBranch(cycle.id, { branchName: 'feature/RUN-8-x', worktreePath: 'C:\wt' });
  const request = createCodeChangeRequest({ devCycleId: cycle.id, origin: 'dev_cycle_merge', repoName: 'r', repoPath: 'C:\wt', cliSessionId: 'merge-1' });
  markCodeChangeReady(request.id, 'C:\wt', 'diff --git a/x b/x');
  markCodeChangeApplied(request.id);

  const apply = mock.method(claudeCodeCliModule, 'applyCodeChangeToRepo', async () => { assert.fail('must not re-apply an already-committed diff'); });
  const push = mock.method(claudeCodeCliModule, 'pushRepoChanges', async () => {});
  const gitCalls: string[] = [];
  mock.method(claudeCodeCliModule, 'git', async (args: string[]) => {
    gitCalls.push(args.join(' '));
    if (args.join(' ') === 'config --get remote.origin.pushurl') return `${LEGACY_NO_PUSH_URL}\n`;
    return '';
  });
  t.after(() => mock.restoreAll());

  const ctx = stepContext(cycle.id);
  const detail = await applyStep().run(ctx);
  assert.equal(detail, 'Pushed to feature/RUN-8-x.');
  assert.equal(apply.mock.callCount(), 0);
  assert.equal(push.mock.callCount(), 1);
  assert.ok(gitCalls.includes('config --unset remote.origin.pushurl'), `legacy block removed: ${gitCalls.join(' | ')}`);
  assert.equal(getCodeChangeRequest(request.id)!.status, 'pushed');
  assert.ok(ctx.logs.some((l) => /already committed by a previous attempt/.test(l)));
  assert.ok(ctx.logs.some((l) => /Removed a leftover push block/.test(l)));
  assert.equal(getDevCycle(cycle.id)!.currentStep, 'done');
});

test('apply_and_push: an already-pushed merge request is a no-op beyond unlocking the next steps', async (t) => {
  const cycle = createDevCycle({ ticketKey: 'RUN-9', repoName: 'r', repoPath: 'C:\repo', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCycleBranch(cycle.id, { branchName: 'feature/RUN-9-x', worktreePath: 'C:\wt' });
  const request = createCodeChangeRequest({ devCycleId: cycle.id, origin: 'dev_cycle_merge', repoName: 'r', repoPath: 'C:\wt', cliSessionId: 'merge-2' });
  markCodeChangeReady(request.id, 'C:\wt', 'diff');
  markCodeChangeApplied(request.id);

  markCodeChangePushed(request.id);
  const push = mock.method(claudeCodeCliModule, 'pushRepoChanges', async () => { assert.fail('must not push twice'); });
  t.after(() => mock.restoreAll());
  await applyStep().run(stepContext(cycle.id));
  assert.equal(push.mock.callCount(), 0);
});

test('devCycleCommitMessage: Jira key first, the ticket summary, one short line, nothing else', async () => {

  assert.equal(devCycleCommitMessage('ETICK-10176', 'Same-day escalation prior (escalationdelaydays=0) not counted'), 'ETICK-10176 Same-day escalation prior (escalationdelaydays=0) not counted');
  assert.equal(devCycleCommitMessage('ETICK-1', '  multi\n  line   summary '), 'ETICK-1 multi line summary');
  assert.equal(devCycleCommitMessage('ETICK-1', null), 'ETICK-1');
  const long = devCycleCommitMessage('ETICK-1', 'x'.repeat(200));
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('…'));
  assert.doesNotMatch(long, /Implement|Speako|Claude|Co-Authored/);
});

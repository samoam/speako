import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle, setDevCyclePlans } from '../src/storage/devCycleRepository';
import { getRun, getRunApprovedSteps, Run } from '../src/storage/runRepository';
import { setRunBroadcast } from '../src/orchestration/engine';
import {
  devCycleRunDefinition,
  devCycleStepsThrough,
  startDevCycleRun,
  getLatestDevCycleRun,
  isDevCycleAwaitingPlanApproval,
  approveDevCyclePlan,
  logDevCycle,
  devCycleView,
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

test('step list: analyze → plan → approval-gated branch_and_worktrees → implement → merge_and_review, in that order', () => {
  const steps = devCycleRunDefinition.steps({ cycleId: 1 }).flat();
  assert.deepEqual(steps.map((s) => s.key), ['analyze', 'plan', 'branch_and_worktrees', 'implement', 'merge_and_review']);
  assert.deepEqual(steps.filter((s) => s.approval).map((s) => s.key), ['branch_and_worktrees'], 'the plan approval is the only human gate');
  assert.ok(steps.every((s) => !s.optional), 'every step is required — a failure stops the run so the user can retry');
});

test('devCycleStepsThrough: the steps a resume keeps, in pipeline order', () => {
  assert.deepEqual(devCycleStepsThrough('analyze'), ['analyze']);
  assert.deepEqual(devCycleStepsThrough('branch_and_worktrees'), ['analyze', 'plan', 'branch_and_worktrees']);
  assert.deepEqual(devCycleStepsThrough('implement'), ['analyze', 'plan', 'branch_and_worktrees', 'implement']);
});

test('startDevCycleRun with a resume past the plan: kept steps start done and the plan approval is implied, so the run does not park for approval again', async () => {
  const cycle = createDevCycle({ ticketKey: 'RUN-1', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  setDevCyclePlans(cycle.id, { claude: plan });
  const run = await startDevCycleRun(cycle.id, { completedThrough: 'implement' });
  assert.deepEqual(run.steps.map((s) => [s.key, s.status]), [['analyze', 'done'], ['plan', 'done'], ['branch_and_worktrees', 'done'], ['implement', 'done'], ['merge_and_review', 'pending']]);
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

test("approveDevCyclePlan / logDevCycle / devCycleView act on the cycle's latest run", async () => {
  const cycle = createDevCycle({ ticketKey: 'RUN-3', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
  assert.equal(approveDevCyclePlan(cycle.id), false, 'no run yet');
  assert.deepEqual(devCycleView(cycle).phases, [], 'a cycle without a run keeps its own (empty) columns');
  const run = await startDevCycleRun(cycle.id, { completedThrough: 'plan' });
  await waitForStatus(run.id, ['waiting_approval']);
  logDevCycle(cycle.id, 'Plan refined per feedback: tighten it');
  const view = devCycleView(getDevCycle(cycle.id)!);
  assert.deepEqual(view.phases.map((p) => p.status), ['done', 'done', 'pending', 'pending', 'pending']);
  assert.equal(view.phases[2].detail, 'Waiting for your approval.');
  assert.match(view.log.at(-1) ?? '', /Plan refined per feedback: tighten it$/);
  assert.equal(approveDevCyclePlan(cycle.id), true);
  // branch_and_worktrees now runs for real and fails (no Jira/git repo here) — what matters is that the approval resumed it.
  const finished = await waitForStatus(run.id, ['done', 'failed'], 30000);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.steps[2].status, 'failed');
  assert.equal(approveDevCyclePlan(cycle.id), false, 'nothing left to approve');
});

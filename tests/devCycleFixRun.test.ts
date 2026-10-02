import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, setDevCycleBranch, getDevCycle } from '../src/storage/devCycleRepository';
import { createCodeChangeRequest } from '../src/storage/codeChangeRequestRepository';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import { upsertJenkinsBuild, setBuildClassification } from '../src/storage/jenkinsBuildRepository';
import { getRun, Run, createRun, tryTransitionRun } from '../src/storage/runRepository';
import * as prFeedbackModule from '../src/dev/prFeedback';
import '../src/orchestration/kinds/prFeedbackRun';
import { setRunBroadcast, cancelRun, INTERRUPTED_ERROR } from '../src/orchestration/engine';
import { StepContext } from '../src/orchestration/types';
import { devCycleFixRunDefinition, startFixRoundIfPossible, MAX_FIX_ROUNDS, DevCycleFixRunState } from '../src/orchestration/kinds/devCycleFixRun';
import { devCycleRunDefinition, getLatestDevCycleRun } from '../src/orchestration/kinds/devCycleRun';
import { FailedBuild, dispatchClaudeChange } from '../src/orchestration/kinds/devCycleSteps';
import * as jenkinsMonitorModule from '../src/dev/jenkinsMonitor';

setRunBroadcast(() => {});

const JOB = '/job/Integration-Test';

function cycleWithBranch(key: string) {
  const cycle = createDevCycle({ ticketKey: key, repoName: 'r', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(cycle.id, { branchName: `feature/${key}-x`, worktreePath: 'C:\\wt' });
  return cycle;
}

function failedBuild(buildNumber: number, newFailures = ['a.T.one']): FailedBuild {
  return { jobPath: JOB, jobFullName: 'Integration-Test', buildNumber, result: 'UNSTABLE', newFailures, reason: 'UNSTABLE — 1 new test failure(s)' };
}

function recordBuild(cycleId: number, buildNumber: number, classification: { category: string; fixable: boolean } | null) {
  const row = upsertJenkinsBuild({ devCycleId: cycleId, jobPath: JOB, branchName: 'feature/x', buildNumber, result: 'UNSTABLE', building: false, url: `https://jenkins/${buildNumber}/`, startedAt: null });
  if (classification) {
    setBuildClassification(row.id, {
      classification: classification.category as any,
      classificationJson: { category: classification.category, confidence: 0.9, summary: 'tests broke', suspectFiles: ['src/A.java'], suspectTests: ['a.T.one'], fixable: classification.fixable, suggestedFix: 'fix it', evidence: [] },
      logExcerpt: '',
    });
  }
  return row;
}

function ctxFor(state: DevCycleFixRunState): StepContext<DevCycleFixRunState> & { logs: string[] } {
  const logs: string[] = [];
  return { runId: 0, state, log: (m) => logs.push(m), detail: () => {}, signal: new AbortController().signal, logs };
}

async function waitForStatus(runId: number, statuses: string[], timeoutMs = 5000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getRun(runId)!;
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} still "${getRun(runId)!.status}" after ${timeoutMs}ms`);
}

test('fix run: analyze_failure → fix → [approve] apply_fix → verify_locally → push → build_and_test', () => {
  const steps = devCycleFixRunDefinition.steps({ cycleId: 1, source: { failedBuild: failedBuild(1) }, round: 1 }).flat();
  assert.deepEqual(steps.map((s) => s.key), ['analyze_failure', 'fix', 'apply_fix', 'verify_locally', 'push', 'build_and_test']);
  assert.deepEqual(steps.filter((s) => s.approval).map((s) => s.key), ['apply_fix'], 'the fix diff is the one human gate of a round');
});

test('analyze_failure: a classified, fixable build passes with its summary and the new failures logged', async (t) => {
  const cycle = cycleWithBranch('FIX-1');
  recordBuild(cycle.id, 10, { category: 'test_regression', fixable: true });
  const ctx = ctxFor({ cycleId: cycle.id, source: { failedBuild: failedBuild(10, ['a.T.one', 'a.T.two']) }, round: 1 });
  const detail = await devCycleFixRunDefinition.steps(ctx.state).flat()[0].run(ctx);
  assert.equal(detail, 'test_regression: tests broke');
  assert.ok(ctx.logs.some((l) => /New failing tests: a\.T\.one, a\.T\.two/.test(l)));
});

test('analyze_failure: an unclassified build asks the monitor once, then fails with a clear message; an unfixable one says why', async (t) => {
  const cycle = cycleWithBranch('FIX-2');
  recordBuild(cycle.id, 11, null);
  const poll = mock.method(jenkinsMonitorModule, 'pollJenkinsBuilds', async () => ({ checked: 0, newFailures: 0 }));
  t.after(() => mock.restoreAll());
  const step = devCycleFixRunDefinition.steps({ cycleId: cycle.id, source: { failedBuild: failedBuild(11) }, round: 1 }).flat()[0];
  await assert.rejects(step.run(ctxFor({ cycleId: cycle.id, source: { failedBuild: failedBuild(11) }, round: 1 })), /Build #11 has not been classified yet/);
  assert.equal(poll.mock.callCount(), 1);

  recordBuild(cycle.id, 12, { category: 'flaky_test', fixable: false });
  await assert.rejects(step.run(ctxFor({ cycleId: cycle.id, source: { failedBuild: failedBuild(12) }, round: 1 })), /flaky_test — not something a code fix can address; rerun the build instead/);
});

test('startFixRoundIfPossible: starts a fix run for a fixable failure, refuses an unfixable one and stops after MAX_FIX_ROUNDS', async () => {
  const cycle = cycleWithBranch('FIX-3');
  recordBuild(cycle.id, 20, { category: 'test_regression', fixable: true });
  assert.equal(await startFixRoundIfPossible(cycle.id, { failedBuild: failedBuild(20) }, MAX_FIX_ROUNDS + 1), null, 'rounds exhausted');

  const run = await startFixRoundIfPossible(cycle.id, { failedBuild: failedBuild(20) }, 2);
  assert.ok(run);
  assert.equal(run!.kind, 'dev_cycle_fix');
  assert.equal((run!.state as DevCycleFixRunState).round, 2);
  assert.equal(getLatestDevCycleRun(cycle.id)?.id, run!.id);
  // Its analyze step passes, then the fix step needs a real agent — fails here, which is fine: it ran.
  const settled = await waitForStatus(run!.id, ['failed', 'done', 'waiting_approval'], 15000);
  assert.equal(settled.steps[0].status, 'done');

  const unfixable = cycleWithBranch('FIX-4');
  recordBuild(unfixable.id, 21, { category: 'infra_failure', fixable: false });
  assert.equal(await startFixRoundIfPossible(unfixable.id, { failedBuild: failedBuild(21) }, 1), null);
  assert.equal(getLatestDevCycleRun(unfixable.id), undefined, 'no run started for an infra failure');
});

test("main run's finalize hands a red build over to fix round 1; a green outcome does not", async () => {
  const cycle = cycleWithBranch('FIX-5');
  recordBuild(cycle.id, 30, { category: 'compile_error', fixable: true });
  const fakeRun = { id: 0, kind: 'dev_cycle', subjectKind: 'dev_cycle', subjectId: String(cycle.id), status: 'failed', steps: [], state: { cycleId: cycle.id, failedBuild: failedBuild(30, []) }, currentStep: 'build_and_test', error: 'red', createdAt: '', updatedAt: '', resolvedAt: null } as any;
  await devCycleRunDefinition.finalize!(fakeRun, 'failed', 'red');
  const started = getLatestDevCycleRun<DevCycleFixRunState>(cycle.id);
  assert.equal(started?.kind, 'dev_cycle_fix');
  assert.equal(started?.state.round, 1);
  assert.equal(started?.state.source.failedBuild?.buildNumber, 30);

  const quiet = cycleWithBranch('FIX-6');
  await devCycleRunDefinition.finalize!({ ...fakeRun, subjectId: String(quiet.id), state: { cycleId: quiet.id } }, 'failed', 'something else');
  assert.equal(getLatestDevCycleRun(quiet.id), undefined, 'a failure that is not a red build starts nothing');
});

test("fix run's finalize: an agent that changed nothing re-enters the local gate (or the build) under the same round number, instead of failing the loop", async () => {
  const cycle = cycleWithBranch('FIX-7');
  const fakeRun = { id: 0, kind: 'dev_cycle_fix', subjectKind: 'dev_cycle', subjectId: String(cycle.id), status: 'failed', steps: [], state: { cycleId: cycle.id, round: 2, source: { localFailure: { summary: 's', failingTests: [], output: '', modules: ['m'] } } }, currentStep: 'fix', error: 'Claude Code agent finished with no file changes.', createdAt: '', updatedAt: '', resolvedAt: null } as any;
  await devCycleFixRunDefinition.finalize!(fakeRun, 'failed', fakeRun.error);
  const started = getLatestDevCycleRun<any>(cycle.id)!;
  assert.equal(started.kind, 'dev_cycle');
  assert.equal(started.state.fixRoundBase, 2, 'a failure of this re-verify starts fix round 3, not round 1');
  assert.deepEqual(started.steps.filter((s) => s.status === 'done').map((s) => s.key), ['analyze', 'plan', 'branch_and_worktrees', 'implement', 'merge_and_review', 'apply'], 'resumes at the local gate');
  await cancelRun(started.id);

  const built = cycleWithBranch('FIX-8');
  await devCycleFixRunDefinition.finalize!({ ...fakeRun, subjectId: String(built.id), state: { cycleId: built.id, round: 1, source: { failedBuild: failedBuild(40) } } }, 'failed', fakeRun.error);
  const rebuild = getLatestDevCycleRun<any>(built.id)!;
  assert.equal(rebuild.kind, 'dev_cycle');
  assert.ok(rebuild.steps.find((s) => s.key === 'push')!.status === 'done' && rebuild.steps.find((s) => s.key === 'build_and_test')!.status !== 'done', 'resumes at the Jenkins build');
  await cancelRun(rebuild.id);
});

test("main run's finalize: a re-verify run carries the fix round forward (fixRoundBase), so the rounds stay bounded", async () => {
  const cycle = cycleWithBranch('FIX-9');
  recordBuild(cycle.id, 50, { category: 'compile_error', fixable: true });
  const fakeRun = { id: 0, kind: 'dev_cycle', subjectKind: 'dev_cycle', subjectId: String(cycle.id), status: 'failed', steps: [], state: { cycleId: cycle.id, fixRoundBase: 2, failedBuild: failedBuild(50, []) }, currentStep: 'build_and_test', error: 'red', createdAt: '', updatedAt: '', resolvedAt: null } as any;
  await devCycleRunDefinition.finalize!(fakeRun, 'failed', 'red');
  assert.equal(getLatestDevCycleRun<DevCycleFixRunState>(cycle.id)?.state.round, 3);

  const exhausted = cycleWithBranch('FIX-10');
  recordBuild(exhausted.id, 51, { category: 'compile_error', fixable: true });
  await devCycleRunDefinition.finalize!({ ...fakeRun, subjectId: String(exhausted.id), state: { cycleId: exhausted.id, fixRoundBase: MAX_FIX_ROUNDS, failedBuild: failedBuild(51, []) } }, 'failed', 'red');
  assert.equal(getLatestDevCycleRun(exhausted.id), undefined, 'past the last round nothing starts');
});

test("main run's finalize: an interrupted run starts no fix round — the engine resumes it instead", async () => {
  const cycle = cycleWithBranch('FIX-11');
  const fakeRun = { id: 0, kind: 'dev_cycle', subjectKind: 'dev_cycle', subjectId: String(cycle.id), status: 'failed', steps: [], state: { cycleId: cycle.id, failedBuild: failedBuild(60, []) }, currentStep: 'build_and_test', error: INTERRUPTED_ERROR, createdAt: '', updatedAt: '', resolvedAt: null } as any;
  await devCycleRunDefinition.finalize!(fakeRun, 'failed', INTERRUPTED_ERROR);
  assert.equal(getLatestDevCycleRun(cycle.id), undefined);
});

test('dispatchClaudeChange: a change request still running from before a restart whose agent is alive is re-attached, not started over', { timeout: 30_000 }, async (t) => {
  const cycle = cycleWithBranch('FIX-12');
  const orphan = createCodeChangeRequest({ devCycleId: cycle.id, origin: 'jenkins_fix', repoName: 'r', repoPath: 'C:\wt', cliSessionId: 'orphan-1' });
  const started = t.mock.method(claudeCodeCliModule, 'startClaudeCodeTask', async () => { throw new Error('a second agent must not be started'); });
  t.mock.method(claudeCodeCliModule, 'getTaskInfo', async () => ({ id: 'orphan-1', cwd: 'C:\tmp\speako-dev-cycle-agent-orphan', state: 'done', name: 'x', waitingFor: null }));
  t.mock.method(claudeCodeCliModule, 'getWorktreeDiff', async () => 'diff --git a/o b/o\n+from before the restart');
  t.mock.method(claudeCodeCliModule, 'getBackgroundTaskLogs', async () => '');
  t.mock.method(claudeCodeCliModule, 'removeAgentScratchWorktree', async () => {});

  const ctx = ctxFor({ cycleId: cycle.id, source: { localFailure: { summary: 's', failingTests: [], output: '', modules: [] } }, round: 1 });
  const outcome = await dispatchClaudeChange(ctx as any, getDevCycle(cycle.id)!, 'prompt', 'C:\wt', 'jenkins_fix');
  assert.equal(outcome.request.id, orphan.id);
  assert.equal(outcome.status, 'ready');
  assert.equal(outcome.diff, 'diff --git a/o b/o\n+from before the restart');
  assert.equal(started.mock.callCount(), 0);
  assert.ok(ctx.logs.some((l) => /Re-attaching to the agent still running/.test(l)));
});

test("fix run's finalize: a fix for a review-feedback round's failure resumes that round (its replies are still to post), and a no-change round retries it with the round carried", async (t) => {
  const cycle = cycleWithBranch('FIX-13');
  // The feedback round that failed its gate, as the engine would have left it.
  const parent = createRun({ kind: 'pr_feedback', subjectKind: 'dev_cycle', subjectId: String(cycle.id), steps: [{ key: 'gather_feedback', label: 'G', status: 'done', detail: null }, { key: 'apply_feedback', label: 'A', status: 'done', detail: null }, { key: 'verify_locally', label: 'V', status: 'failed', detail: null }, { key: 'post_replies', label: 'P', status: 'pending', detail: null }], state: { cycleId: cycle.id, round: 1 } });
  tryTransitionRun(parent.id, ['queued'], 'running');
  tryTransitionRun(parent.id, ['running'], 'failed', 'gate failed');
  t.mock.method(prFeedbackModule, 'watchDevCyclePr', async () => ({ kind: 'open', threads: [] }) as any);

  const fixRun = { id: 0, kind: 'dev_cycle_fix', subjectKind: 'dev_cycle', subjectId: String(cycle.id), status: 'done', steps: [], state: { cycleId: cycle.id, round: 1, source: { localFailure: { summary: 's', failingTests: [], output: '', modules: [] } } }, currentStep: 'build_and_test', error: null, createdAt: '', updatedAt: '', resolvedAt: null } as any;
  await devCycleFixRunDefinition.finalize!(fixRun, 'done', null);
  const resumed = getLatestDevCycleRun<any>(cycle.id)!;
  assert.equal(resumed.kind, 'pr_feedback');
  assert.notEqual(resumed.id, parent.id);
  assert.deepEqual(resumed.steps.filter((s) => s.status === 'done').map((s) => s.key).slice(0, 2), ['gather_feedback', 'apply_feedback'].filter((k) => resumed.steps.some((s) => s.key === k && s.status === 'done')));
  await cancelRun(resumed.id);
  tryTransitionRun(resumed.id, ['cancelled'], 'failed', 'gate failed again');

  await devCycleFixRunDefinition.finalize!({ ...fixRun, status: 'failed', currentStep: 'fix', state: { ...fixRun.state, round: 2 } }, 'failed', 'Claude Code agent finished with no file changes.');
  const retried = getLatestDevCycleRun<any>(cycle.id)!;
  assert.equal(retried.kind, 'pr_feedback');
  assert.equal(retried.state.fixRoundBase, 2);
  await cancelRun(retried.id);
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, setDevCycleBranch } from '../src/storage/devCycleRepository';
import { upsertJenkinsBuild, setBuildClassification } from '../src/storage/jenkinsBuildRepository';
import { getRun, Run } from '../src/storage/runRepository';
import { setRunBroadcast } from '../src/orchestration/engine';
import { StepContext } from '../src/orchestration/types';
import { devCycleFixRunDefinition, startFixRoundIfPossible, MAX_FIX_ROUNDS, DevCycleFixRunState } from '../src/orchestration/kinds/devCycleFixRun';
import { devCycleRunDefinition, getLatestDevCycleRun } from '../src/orchestration/kinds/devCycleRun';
import { FailedBuild } from '../src/orchestration/kinds/devCycleSteps';
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

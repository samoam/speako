import test from 'node:test';
import assert from 'node:assert/strict';
import { unstampLogLine } from '../src/storage/logLine';
import { getRun, getRunLog, createRun, tryTransitionRun, setRunStep, Run } from '../src/storage/runRepository';
import { registerRunKind, startRun, approveRun, cancelRun, isRunActive, setRunBroadcast, reconcileRunsOnStartup, retryRun, logRun } from '../src/orchestration/engine';
import { RunBroadcastEvent, RunDefinition, StepEntry } from '../src/orchestration/types';

const events: RunBroadcastEvent[] = [];
setRunBroadcast((e) => events.push(e));

/** Polls until the run reaches a status in `statuses` — the engine runs steps on its own microtasks, so tests wait on the persisted row rather than on a returned promise. */
async function waitForStatus(runId: number, statuses: string[], timeoutMs = 5000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getRun(runId)!;
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} still "${getRun(runId)!.status}" after ${timeoutMs}ms`);
}

/** A unique kind per test so one test's definition can't bleed into another. */
let kindCounter = 0;
function defineKind<S>(steps: (state: S) => StepEntry<S>[], finalize?: RunDefinition<S>['finalize']): string {
  const kind = `test_kind_${++kindCounter}`;
  registerRunKind<S>({ kind, steps, finalize });
  return kind;
}

const stepStatuses = (run: Run) => Object.fromEntries(run.steps.map((s) => [s.key, s.status]));

test('startRun: creates the run queued with every step pending, then runs the steps in order, persisting state and marking it done', async () => {
  const order: string[] = [];
  const finalized: { outcome: string; state: any }[] = [];
  const kind = defineKind<{ seen: string[] }>(
    () => [
      { key: 'one', label: 'One', run: async (ctx) => { order.push('one'); ctx.state.seen.push('one'); ctx.log('hello from one'); return 'one done'; } },
      { key: 'two', label: 'Two', run: async (ctx) => { order.push('two'); ctx.state.seen.push('two'); } },
    ],
    async (run, outcome) => { finalized.push({ outcome, state: run.state }); }
  );
  const run = startRun({ kind, subjectKind: 'task', subjectId: '1', state: { seen: [] } });
  assert.deepEqual(stepStatuses(run), { one: 'pending', two: 'pending' });

  const done = await waitForStatus(run.id, ['done', 'failed']);
  assert.equal(done.status, 'done');
  assert.deepEqual(order, ['one', 'two']);
  assert.deepEqual(done.steps.map((s) => [s.key, s.status, s.detail]), [['one', 'done', 'one done'], ['two', 'done', null]]);
  assert.deepEqual(done.state, { seen: ['one', 'two'] }, 'state mutated by steps is persisted');
  assert.deepEqual(getRunLog(run.id).map(unstampLogLine), ['hello from one']);
  assert.ok(done.resolvedAt);
  // finalize ran exactly once, after the last step, with the final state.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(finalized, [{ outcome: 'done', state: { seen: ['one', 'two'] } }]);
  assert.equal(isRunActive(run.id), false);
});

test('a required step that throws fails the run, skips the remaining steps and finalizes with the error', async () => {
  const finalized: { outcome: string; error: string | null }[] = [];
  const kind = defineKind<{}>(
    () => [
      { key: 'ok', label: 'Ok', run: async () => {} },
      { key: 'boom', label: 'Boom', run: async () => { throw new Error('kaboom'); } },
      { key: 'never', label: 'Never', run: async () => { assert.fail('must not run after a required failure'); } },
    ],
    async (_run, outcome, error) => { finalized.push({ outcome, error }); }
  );
  const run = startRun({ kind, subjectKind: 'task', subjectId: '2', state: {} });
  const failed = await waitForStatus(run.id, ['done', 'failed']);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'kaboom');
  assert.deepEqual(stepStatuses(failed), { ok: 'done', boom: 'failed', never: 'skipped' });
  assert.equal(failed.steps[1].detail, 'kaboom');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(finalized, [{ outcome: 'failed', error: 'kaboom' }]);
});

test('an optional step that throws is recorded as failed but the run carries on', async () => {
  const kind = defineKind<{}>(() => [
    { key: 'extra', label: 'Extra', optional: true, run: async () => { throw new Error('no second opinion'); } },
    { key: 'main', label: 'Main', run: async () => 'fine' },
  ]);
  const run = startRun({ kind, subjectKind: 'task', subjectId: '3', state: {} });
  const done = await waitForStatus(run.id, ['done', 'failed']);
  assert.equal(done.status, 'done');
  assert.deepEqual(stepStatuses(done), { extra: 'failed', main: 'done' });
  assert.match(getRunLog(run.id).join('\n'), /Extra failed — continuing without it: no second opinion/);
});

test('a parallel group runs its steps concurrently, each with its own checklist line', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const slow = (key: string) => ({
    key,
    label: key,
    async run() {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return `${key} ok`;
    },
  });
  const kind = defineKind<{}>(() => [[slow('left'), slow('right')], { key: 'after', label: 'After', run: async () => {} }]);
  const run = startRun({ kind, subjectKind: 'task', subjectId: '4', state: {} });
  const done = await waitForStatus(run.id, ['done', 'failed']);
  assert.equal(done.status, 'done');
  assert.equal(maxConcurrent, 2, 'both steps of the group were in flight at once');
  assert.deepEqual(done.steps.map((s) => [s.key, s.status, s.detail]), [['left', 'done', 'left ok'], ['right', 'done', 'right ok'], ['after', 'done', null]]);
});

test('a step timeout fails the step with the engine\'s "timed out" error', async () => {
  const kind = defineKind<{}>(() => [{ key: 'hang', label: 'Hanging step', timeoutMs: 30, run: () => new Promise(() => {}) }]);
  const run = startRun({ kind, subjectKind: 'task', subjectId: '5', state: {} });
  const failed = await waitForStatus(run.id, ['done', 'failed']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /Hanging step timed out after 0s/);
});

test('an approval step parks the run at waiting_approval; approveRun resumes it from that step (not from the start)', async () => {
  const ran: string[] = [];
  const kind = defineKind<{}>(() => [
    { key: 'plan', label: 'Plan', run: async () => { ran.push('plan'); return 'the plan'; } },
    { key: 'implement', label: 'Implement', approval: true, run: async () => { ran.push('implement'); } },
  ]);
  const run = startRun({ kind, subjectKind: 'task', subjectId: '6', state: {} });
  const waiting = await waitForStatus(run.id, ['waiting_approval', 'done', 'failed']);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.currentStep, 'implement');
  assert.deepEqual(waiting.steps.map((s) => [s.key, s.status, s.detail]), [['plan', 'done', 'the plan'], ['implement', 'pending', 'Waiting for your approval.']]);
  assert.deepEqual(ran, ['plan']);
  assert.equal(isRunActive(run.id), false, 'a parked run holds no worker slot');

  assert.equal(approveRun(run.id), true);
  const done = await waitForStatus(run.id, ['done', 'failed']);
  assert.equal(done.status, 'done');
  assert.deepEqual(ran, ['plan', 'implement'], 'plan did not run a second time');
  assert.equal(approveRun(run.id), false, 'nothing to approve once finished');
});

test('cancelRun: a queued-or-waiting run is cancelled immediately; a running one stops after its current step and skips the rest', async () => {
  const finalized: string[] = [];
  const waitingKind = defineKind<{}>(
    () => [{ key: 'gate', label: 'Gate', approval: true, run: async () => {} }],
    async (_run, outcome) => { finalized.push(outcome); }
  );
  const parked = startRun({ kind: waitingKind, subjectKind: 'task', subjectId: '7', state: {} });
  await waitForStatus(parked.id, ['waiting_approval']);
  assert.equal(await cancelRun(parked.id), true);
  assert.equal(getRun(parked.id)!.status, 'cancelled');
  assert.deepEqual(finalized, ['cancelled']);
  assert.equal(await cancelRun(parked.id), false, 'already finished');

  let release!: () => void;
  const runningKind = defineKind<{}>(() => [
    { key: 'slow', label: 'Slow', run: () => new Promise<void>((r) => { release = r; }) },
    { key: 'next', label: 'Next', run: async () => { assert.fail('must not run after cancel'); } },
  ]);
  const running = startRun({ kind: runningKind, subjectKind: 'task', subjectId: '8', state: {} });
  await waitForStatus(running.id, ['running']);
  await new Promise((r) => setTimeout(r, 10)); // let the slow step start so `release` is assigned
  assert.equal(await cancelRun(running.id), true);
  assert.equal(getRun(running.id)!.status, 'cancelled', 'status flips as soon as cancel is requested');
  release();
  await new Promise((r) => setTimeout(r, 50));
  const cancelled = getRun(running.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(stepStatuses(cancelled), { slow: 'done', next: 'skipped' });
  assert.equal(isRunActive(running.id), false);
});

test('broadcast: run-status on every status change, run-step per step transition, run-log per log line', async () => {
  const kind = defineKind<{}>(() => [{ key: 's', label: 'S', run: async (ctx) => { ctx.log('line'); ctx.detail('working…'); } }]);
  events.length = 0;
  const run = startRun({ kind, subjectKind: 'task', subjectId: '9', state: {} });
  await waitForStatus(run.id, ['done']);
  await new Promise((r) => setTimeout(r, 20));
  const mine = events.filter((e) => (e.type === 'run-status' ? e.run.id === run.id : e.runId === run.id));
  const statuses = mine.filter((e) => e.type === 'run-status').map((e: any) => e.run.status);
  assert.deepEqual(statuses, ['queued', 'running', 'done']);
  const steps = mine.filter((e) => e.type === 'run-step').map((e: any) => [e.step.status, e.step.detail]);
  assert.deepEqual(steps, [['running', null], ['running', 'working…'], ['done', null]]);
  assert.deepEqual(mine.filter((e) => e.type === 'run-log').map((e: any) => [e.kind, e.subjectId, e.message]), [[kind, '9', 'line']]);
});

test('reconcileRunsOnStartup: runs left "running" by a dead process are failed with their cleanup run; queued runs are started', async () => {
  const finalized: string[] = [];
  const kind = defineKind<{}>(
    () => [{ key: 's', label: 'S', run: async () => {} }],
    async (_run, outcome, error) => { finalized.push(`${outcome}:${error}`); }
  );
  // Simulate a previous process: a row that says running with nothing behind it.
  const orphan = createRun({ kind, subjectKind: 'task', subjectId: '10', steps: [{ key: 's', label: 'S', status: 'pending', detail: null }], state: {} });
  tryTransitionRun(orphan.id, ['queued'], 'running');
  setRunStep(orphan.id, 's', 'running');
  const queued = createRun({ kind, subjectKind: 'task', subjectId: '11', steps: [{ key: 's', label: 'S', status: 'pending', detail: null }], state: {} });

  const count = await reconcileRunsOnStartup();
  assert.ok(count >= 1);
  const failed = getRun(orphan.id)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /restarted/);
  assert.equal(failed.steps[0].status, 'failed');
  assert.ok(finalized.some((f) => f.startsWith('failed:Interrupted')), `finalize ran for the orphan: ${JSON.stringify(finalized)}`);
  assert.equal((await waitForStatus(queued.id, ['done', 'failed'])).status, 'done', 'the queued run was picked up');
});

test('startRun with resume: listed steps start done and listed gates start approved, so the run begins at the first unsettled step', async () => {
  const ran: string[] = [];
  const kind = defineKind<{}>(() => [
    { key: 'a', label: 'A', run: async () => { ran.push('a'); } },
    { key: 'gate', label: 'Gate', approval: true, run: async () => { ran.push('gate'); } },
    { key: 'c', label: 'C', run: async () => { ran.push('c'); } },
  ]);
  const run = startRun({ kind, subjectKind: 'task', subjectId: '12', state: {}, resume: { completed: ['a'], approved: ['gate'] } });
  assert.equal(run.steps[0].status, 'done');
  assert.equal(run.steps[0].detail, 'Kept from the previous run.');
  const done = await waitForStatus(run.id, ['done', 'failed', 'waiting_approval']);
  assert.equal(done.status, 'done', 'the pre-approved gate did not park the run');
  assert.deepEqual(ran, ['gate', 'c']);
});

test("retryRun: a new run of the same kind/state that keeps the failed run's finished steps and approvals, re-running only from the failure", async () => {
  let failOnce = true;
  const ran: string[] = [];
  const kind = defineKind<{ n: number }>(() => [
    { key: 'plan', label: 'Plan', run: async () => { ran.push('plan'); } },
    { key: 'gate', label: 'Gate', approval: true, run: async () => { ran.push('gate'); } },
    { key: 'flaky', label: 'Flaky', run: async () => { ran.push('flaky'); if (failOnce) { failOnce = false; throw new Error('transient'); } } },
    { key: 'last', label: 'Last', run: async () => { ran.push('last'); } },
  ]);
  const first = startRun({ kind, subjectKind: 'task', subjectId: '13', state: { n: 1 } });
  await waitForStatus(first.id, ['waiting_approval']);
  approveRun(first.id);
  const failed = await waitForStatus(first.id, ['done', 'failed']);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(stepStatuses(failed), { plan: 'done', gate: 'done', flaky: 'failed', last: 'skipped' });

  assert.equal(retryRun(first.id + 100000), null, 'unknown run');
  const retry = retryRun(first.id)!;
  assert.notEqual(retry.id, first.id);
  assert.deepEqual(retry.state, { n: 1 });
  const done = await waitForStatus(retry.id, ['done', 'failed', 'waiting_approval']);
  assert.equal(done.status, 'done');
  assert.deepEqual(stepStatuses(done), { plan: 'done', gate: 'done', flaky: 'done', last: 'done' });
  assert.deepEqual(ran, ['plan', 'gate', 'flaky', 'flaky', 'last'], 'plan and the approved gate did not run again');
});

test("logRun: appends to the run's log and broadcasts it like a step would", async () => {
  const kind = defineKind<{}>(() => [{ key: 'gate', label: 'Gate', approval: true, run: async () => {} }]);
  const run = startRun({ kind, subjectKind: 'task', subjectId: '14', state: {} });
  await waitForStatus(run.id, ['waiting_approval']);
  events.length = 0;
  logRun(run.id, 'refined by hand');
  assert.deepEqual(getRunLog(run.id).map(unstampLogLine), ['refined by hand']);
  assert.deepEqual(events.map((e: any) => [e.type, e.message]), [['run-log', 'refined by hand']]);
});

test('reconcileRunsOnStartup: a kind that opts in (resumeOnRestart) is retried from its interrupted step, finished steps kept', async () => {
  const ran: string[] = [];
  const kind = `test_kind_resume_${Date.now()}`;
  registerRunKind<{}>({
    kind,
    steps: () => [
      { key: 'a', label: 'A', run: async () => { ran.push('a'); } },
      { key: 'b', label: 'B', run: async () => { ran.push('b'); } },
    ],
    resumeOnRestart: true,
  });
  const orphan = createRun({ kind, subjectKind: 'task', subjectId: '12', steps: [{ key: 'a', label: 'A', status: 'done', detail: null }, { key: 'b', label: 'B', status: 'pending', detail: null }], state: {} });
  tryTransitionRun(orphan.id, ['queued'], 'running');
  setRunStep(orphan.id, 'b', 'running');

  await reconcileRunsOnStartup();
  assert.equal(getRun(orphan.id)!.status, 'failed', 'the interrupted run itself stays failed, for the record');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !ran.includes('b')) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ran, ['b'], 'only the interrupted step re-ran, in a new run');
});

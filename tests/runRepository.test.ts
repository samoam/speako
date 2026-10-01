import test from 'node:test';
import assert from 'node:assert/strict';
import { unstampLogLine } from '../src/storage/logLine';
import {
  createRun,
  getRun,
  getLatestRunForSubject,
  getRunsByStatus,
  tryTransitionRun,
  setRunState,
  setRunStep,
  appendRunEvent,
  hasRunEvent,
  getRunLog,
  failInterruptedRuns,
  RunStep,
} from '../src/storage/runRepository';

const steps = (): RunStep[] => [
  { key: 'a', label: 'Step A', status: 'pending', detail: null },
  { key: 'b', label: 'Step B', status: 'pending', detail: null },
];

test('createRun: starts queued with the given steps and state, and round-trips', () => {
  const run = createRun({ kind: 'k', subjectKind: 'task', subjectId: '1', steps: steps(), state: { n: 1 } });
  assert.equal(run.status, 'queued');
  assert.deepEqual(run.steps, steps());
  assert.deepEqual(run.state, { n: 1 });
  assert.equal(run.currentStep, null);
  assert.deepEqual(getRun(run.id), run);
});

test('getLatestRunForSubject: the most recent run for that subject only', () => {
  const first = createRun({ kind: 'k', subjectKind: 'task', subjectId: 'subj-latest', steps: steps(), state: {} });
  const second = createRun({ kind: 'k', subjectKind: 'task', subjectId: 'subj-latest', steps: steps(), state: {} });
  createRun({ kind: 'k', subjectKind: 'task', subjectId: 'other', steps: steps(), state: {} });
  assert.equal(getLatestRunForSubject('task', 'subj-latest')?.id, second.id);
  assert.notEqual(getLatestRunForSubject('task', 'subj-latest')?.id, first.id);
});

test('tryTransitionRun: only moves from an expected status; terminal statuses set resolvedAt', () => {
  const run = createRun({ kind: 'k', subjectKind: 'task', subjectId: '2', steps: steps(), state: {} });
  assert.equal(tryTransitionRun(run.id, ['running'], 'done'), false, 'a queued run is not running');
  assert.equal(getRun(run.id)!.status, 'queued');
  assert.equal(tryTransitionRun(run.id, ['queued'], 'running'), true);
  assert.equal(getRun(run.id)!.resolvedAt, null);
  assert.equal(tryTransitionRun(run.id, ['running'], 'failed', 'boom'), true);
  const failed = getRun(run.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
  assert.ok(failed.resolvedAt);
});

test('setRunStep: updates one step, tracks the current step, records a step event; unknown key is a no-op', () => {
  const run = createRun({ kind: 'k', subjectKind: 'task', subjectId: '3', steps: steps(), state: {} });
  setRunStep(run.id, 'a', 'running');
  assert.equal(getRun(run.id)!.currentStep, 'a');
  setRunStep(run.id, 'a', 'done', 'all good');
  const after = getRun(run.id)!;
  assert.deepEqual(after.steps[0], { key: 'a', label: 'Step A', status: 'done', detail: 'all good' });
  assert.equal(after.steps[1].status, 'pending');
  assert.doesNotThrow(() => setRunStep(run.id, 'nope', 'done'));
  assert.deepEqual(getRunLog(run.id), [], 'step transitions are not log lines');
});

test('appendRunEvent/getRunLog: log lines come back in order, time-stamped, without step/approval events mixed in', () => {
  const run = createRun({ kind: 'k', subjectKind: 'task', subjectId: '4', steps: steps(), state: {} });
  appendRunEvent(run.id, 'log', null, 'first');
  setRunStep(run.id, 'a', 'running');
  appendRunEvent(run.id, 'approval', 'b', 'Approved.');
  appendRunEvent(run.id, 'log', null, 'second');
  const log = getRunLog(run.id);
  assert.ok(log.every((line) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] /.test(line)), `every line should be time-stamped: ${JSON.stringify(log)}`);
  assert.deepEqual(log.map(unstampLogLine), ['first', 'second']);
  assert.equal(hasRunEvent(run.id, 'approval', 'b'), true);
  assert.equal(hasRunEvent(run.id, 'approval', 'a'), false);
});

test('setRunState: replaces the persisted state', () => {
  const run = createRun({ kind: 'k', subjectKind: 'task', subjectId: '5', steps: steps(), state: { n: 1 } });
  setRunState(run.id, { n: 2, extra: true });
  assert.deepEqual(getRun(run.id)!.state, { n: 2, extra: true });
});

test('failInterruptedRuns: fails every running run and its running steps, leaves queued/waiting/finished runs alone', () => {
  const running = createRun({ kind: 'k', subjectKind: 'task', subjectId: 'r1', steps: steps(), state: {} });
  tryTransitionRun(running.id, ['queued'], 'running');
  setRunStep(running.id, 'a', 'done');
  setRunStep(running.id, 'b', 'running');
  const queued = createRun({ kind: 'k', subjectKind: 'task', subjectId: 'r2', steps: steps(), state: {} });
  const waiting = createRun({ kind: 'k', subjectKind: 'task', subjectId: 'r3', steps: steps(), state: {} });
  tryTransitionRun(waiting.id, ['queued'], 'waiting_approval');

  const count = failInterruptedRuns('restarted');
  assert.ok(count >= 1);
  const failed = getRun(running.id)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'restarted');
  assert.equal(failed.steps[0].status, 'done', 'a finished step keeps its status');
  assert.equal(failed.steps[1].status, 'failed');
  assert.equal(failed.steps[1].detail, 'restarted');
  assert.equal(getRun(queued.id)!.status, 'queued');
  assert.equal(getRun(waiting.id)!.status, 'waiting_approval');
  assert.ok(getRunsByStatus(['queued']).some((r) => r.id === queued.id));
});

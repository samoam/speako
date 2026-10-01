import test from 'node:test';
import assert from 'node:assert/strict';
import { unstampLogLine } from '../src/storage/logLine';

/** Log lines carry a "[<ISO time>] " prefix (src/storage/logLine.ts) — checks it's there, then compares the messages. */
function assertStampedLog(log: string[] | undefined, expected: string[]): void {
  assert.ok(log && log.every((line) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] /.test(line)), `every line should be time-stamped: ${JSON.stringify(log)}`);
  assert.deepEqual(log!.map(unstampLogLine), expected);
}

import { createDevCycle } from '../src/storage/devCycleRepository';
import { createCodeChangeRequest } from '../src/storage/codeChangeRequestRepository';
import {
  createDevCycleImplementation,
  getDevCycleImplementation,
  getDevCycleImplementationsForCycle,
  appendDevCycleImplementationLog,
  markDevCycleImplementationReady,
  markDevCycleImplementationFailed,
} from '../src/storage/devCycleImplementationRepository';

function seedCycle(ticketKey: string) {
  return createDevCycle({ ticketKey, repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });
}

test('createDevCycleImplementation: defaults status to running, round-trips via getDevCycleImplementation', () => {
  const cycle = seedCycle('IMPL-1');
  const codeChangeRequest = createCodeChangeRequest({ devCycleId: cycle.id, origin: 'dev_cycle_implement', repoName: 'r', repoPath: 'C:\\wt\\a', cliSessionId: 'cli-1' });
  const impl = createDevCycleImplementation({
    devCycleId: cycle.id,
    round: cycle.round,
    variant: 'claude',
    worktreePath: 'C:\\wt\\a',
    codeChangeRequestId: codeChangeRequest.id,
  });
  assert.equal(impl.status, 'running');
  assert.equal(impl.variant, 'claude');
  assert.equal(impl.codeChangeRequestId, codeChangeRequest.id);
  assert.equal(impl.cliSessionId, null);
  assert.deepEqual(impl.log, []);
  assert.deepEqual(getDevCycleImplementation(impl.id), impl);
});

test('getDevCycleImplementationsForCycle: scoped to (devCycleId, round), ordered by insertion', () => {
  const cycle = seedCycle('IMPL-2');
  const claude = createDevCycleImplementation({ devCycleId: cycle.id, round: 1, variant: 'claude', worktreePath: 'C:\\wt\\a' });
  const gemini = createDevCycleImplementation({ devCycleId: cycle.id, round: 1, variant: 'gemini', worktreePath: 'C:\\wt\\b', cliSessionId: '1234' });
  createDevCycleImplementation({ devCycleId: cycle.id, round: 2, variant: 'claude', worktreePath: 'C:\\wt\\c' });

  const round1 = getDevCycleImplementationsForCycle(cycle.id, 1);
  assert.deepEqual(round1.map((r) => r.id), [claude.id, gemini.id]);
});

test('appendDevCycleImplementationLog / markDevCycleImplementationReady / markDevCycleImplementationFailed update the expected fields', () => {
  const cycle = seedCycle('IMPL-3');
  const impl = createDevCycleImplementation({ devCycleId: cycle.id, round: 1, variant: 'gemini', worktreePath: 'C:\\wt\\a', cliSessionId: '999' });

  appendDevCycleImplementationLog(impl.id, 'Starting…');
  appendDevCycleImplementationLog(impl.id, 'Working…');
  assertStampedLog(getDevCycleImplementation(impl.id)?.log, ['Starting…', 'Working…']);

  markDevCycleImplementationReady(impl.id, 'diff --git a/x b/x');
  let updated = getDevCycleImplementation(impl.id)!;
  assert.equal(updated.status, 'ready');
  assert.equal(updated.diff, 'diff --git a/x b/x');
  assert.ok(updated.resolvedAt);

  const other = createDevCycleImplementation({ devCycleId: cycle.id, round: 1, variant: 'claude', worktreePath: 'C:\\wt\\b' });
  markDevCycleImplementationFailed(other.id, 'agent crashed');
  updated = getDevCycleImplementation(other.id)!;
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'agent crashed');
  assert.ok(updated.resolvedAt);
});

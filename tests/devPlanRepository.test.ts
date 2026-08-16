import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle } from '../src/storage/devCycleRepository';
import {
  createDevPlan,
  getDevPlan,
  getLatestDevPlanForCycle,
  appendDevPlanLog,
  markDevPlanReady,
  markDevPlanFailed,
  markDevPlanApproved,
  markDevPlanRejected,
  supersedeOpenPlansForCycle,
} from '../src/storage/devPlanRepository';

function seedCycle(ticketKey: string): number {
  return createDevCycle({ ticketKey, repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' }).id;
}

test('createDevPlan: defaults status "running" and attempt 1, round-trips via getDevPlan', () => {
  const cycleId = seedCycle('PROJ-10');
  const plan = createDevPlan({ devCycleId: cycleId, round: 1, seedContext: { ticket: { key: 'PROJ-10' } } });
  assert.equal(plan.status, 'running');
  assert.equal(plan.attempt, 1);
  assert.deepEqual(plan.seedContext, { ticket: { key: 'PROJ-10' } });
  assert.deepEqual(getDevPlan(plan.id), plan);
});

test('getLatestDevPlanForCycle: returns the most recent attempt', () => {
  const cycleId = seedCycle('PROJ-11');
  const first = createDevPlan({ devCycleId: cycleId, round: 1 });
  const second = createDevPlan({ devCycleId: cycleId, round: 1, attempt: 2, feedback: 'add error handling' });
  const latest = getLatestDevPlanForCycle(cycleId);
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.feedback, 'add error handling');
  assert.notEqual(latest?.id, first.id);
});

test('appendDevPlanLog: appends progress lines in order', () => {
  const cycleId = seedCycle('PROJ-12');
  const plan = createDevPlan({ devCycleId: cycleId, round: 1 });
  appendDevPlanLog(plan.id, 'Searching codebase...');
  appendDevPlanLog(plan.id, 'Reading Jira ticket...');
  assert.deepEqual(getDevPlan(plan.id)?.log, ['Searching codebase...', 'Reading Jira ticket...']);
});

test('markDevPlanReady / markDevPlanApproved / markDevPlanRejected / markDevPlanFailed', () => {
  const cycleId = seedCycle('PROJ-13');
  const plan = createDevPlan({ devCycleId: cycleId, round: 1 });
  const structuredPlan = { understanding: 'Add retry logic', approach: 'Wrap the call', files: [], tests: [], risks: [], openQuestions: [], estimatedSize: 's' };
  markDevPlanReady(plan.id, structuredPlan);
  let updated = getDevPlan(plan.id)!;
  assert.equal(updated.status, 'ready');
  assert.deepEqual(updated.plan, structuredPlan);
  assert.ok(updated.resolvedAt);

  markDevPlanApproved(plan.id);
  assert.equal(getDevPlan(plan.id)?.status, 'approved');

  const rejectedPlan = createDevPlan({ devCycleId: cycleId, round: 1, attempt: 2 });
  markDevPlanRejected(rejectedPlan.id);
  assert.equal(getDevPlan(rejectedPlan.id)?.status, 'rejected');

  const failedPlan = createDevPlan({ devCycleId: cycleId, round: 1, attempt: 3 });
  markDevPlanFailed(failedPlan.id, 'agent crashed');
  const failedUpdated = getDevPlan(failedPlan.id)!;
  assert.equal(failedUpdated.status, 'failed');
  assert.equal(failedUpdated.error, 'agent crashed');
});

test('supersedeOpenPlansForCycle: marks running/ready plans superseded, leaves terminal ones alone', () => {
  const cycleId = seedCycle('PROJ-14');
  const running = createDevPlan({ devCycleId: cycleId, round: 1 });
  const ready = createDevPlan({ devCycleId: cycleId, round: 1, attempt: 2 });
  markDevPlanReady(ready.id, { understanding: '', approach: '', files: [], tests: [], risks: [], openQuestions: [], estimatedSize: 'xs' });
  const approved = createDevPlan({ devCycleId: cycleId, round: 1, attempt: 3 });
  markDevPlanApproved(approved.id);

  supersedeOpenPlansForCycle(cycleId);

  assert.equal(getDevPlan(running.id)?.status, 'superseded');
  assert.equal(getDevPlan(ready.id)?.status, 'superseded');
  assert.equal(getDevPlan(approved.id)?.status, 'approved');
});

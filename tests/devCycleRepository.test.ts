import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDevCycle,
  getDevCycle,
  getActiveDevCycleForTicket,
  getActiveDevCycles,
  setDevCycleBranch,
  setDevCycleState,
  setDevCyclePr,
  setDevCycleJenkinsJob,
  bumpDevCycleRound,
  closeDevCycle,
} from '../src/storage/devCycleRepository';

test('createDevCycle: defaults base_branch to "main" and round to 1, round-trips via getDevCycle', () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-1', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'Dev Ready' });
  assert.equal(cycle.baseBranch, 'main');
  assert.equal(cycle.round, 1);
  assert.equal(cycle.status, 'active');
  assert.equal(cycle.branchName, null);
  assert.deepEqual(getDevCycle(cycle.id), cycle);
});

test('getActiveDevCycleForTicket: finds the active cycle, not a closed one', () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-2', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'bugfix', lifecycleState: 'Dev Ready' });
  assert.equal(getActiveDevCycleForTicket('PROJ-2')?.id, cycle.id);

  closeDevCycle(cycle.id, 'done');
  assert.equal(getActiveDevCycleForTicket('PROJ-2'), undefined);
});

test('getActiveDevCycles: only returns active-status rows', () => {
  const active = createDevCycle({ ticketKey: 'PROJ-3', repoName: 'r', repoPath: 'p', branchType: 'chore', lifecycleState: 'Dev Ready' });
  const abandoned = createDevCycle({ ticketKey: 'PROJ-4', repoName: 'r', repoPath: 'p', branchType: 'chore', lifecycleState: 'Dev Ready' });
  closeDevCycle(abandoned.id, 'abandoned');

  const ids = getActiveDevCycles().map((c) => c.id);
  assert.ok(ids.includes(active.id));
  assert.ok(!ids.includes(abandoned.id));
});

test('setDevCycleBranch / setDevCycleState / setDevCyclePr / setDevCycleJenkinsJob update the expected fields', () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-5', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'Dev Ready' });

  setDevCycleBranch(cycle.id, { branchName: 'feature/PROJ-5-add-thing', worktreePath: 'C:\\wt\\proj5' });
  let updated = getDevCycle(cycle.id)!;
  assert.equal(updated.branchName, 'feature/PROJ-5-add-thing');
  assert.equal(updated.worktreePath, 'C:\\wt\\proj5');

  setDevCycleState(cycle.id, 'In Progress');
  assert.equal(getDevCycle(cycle.id)?.lifecycleState, 'In Progress');

  setDevCyclePr(cycle.id, { projectKey: 'PROJ', repoSlug: 'repo', prId: 123, prUrl: 'https://bitbucket/pr/123' });
  updated = getDevCycle(cycle.id)!;
  assert.equal(updated.prProjectKey, 'PROJ');
  assert.equal(updated.prRepoSlug, 'repo');
  assert.equal(updated.prId, 123);
  assert.equal(updated.prUrl, 'https://bitbucket/pr/123');

  setDevCycleJenkinsJob(cycle.id, '/job/Team/job/officercc/job/feature%2FPROJ-5-add-thing');
  assert.equal(getDevCycle(cycle.id)?.jenkinsJobPath, '/job/Team/job/officercc/job/feature%2FPROJ-5-add-thing');
});

test('bumpDevCycleRound: increments round for the Return loop', () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-6', repoName: 'r', repoPath: 'p', branchType: 'feature', lifecycleState: 'QA Ready' });
  assert.equal(cycle.round, 1);
  bumpDevCycleRound(cycle.id);
  assert.equal(getDevCycle(cycle.id)?.round, 2);
  bumpDevCycleRound(cycle.id);
  assert.equal(getDevCycle(cycle.id)?.round, 3);
});

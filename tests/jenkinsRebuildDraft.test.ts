import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, setDevCycleJenkinsJob, setDevCycleBranch, getDevCycle } from '../src/storage/devCycleRepository';
import * as jenkinsMcpModule from '../src/integrations/jenkinsMcp';
import { getJenkinsBuildRequestsForCycle } from '../src/storage/jenkinsBuildRequestRepository';
import { _setConfigOverrides } from '../src/config';
import * as jenkinsClientModule from '../src/integrations/jenkinsClient';
import { jenkinsRebuildDraft } from '../src/drafts/kinds/jenkinsRebuildDraft';

test('jenkinsRebuildDraft.generate: throws when the cycle has no job and no shared build-and-test job is configured', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-1', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  await assert.rejects(() => jenkinsRebuildDraft.generate({ draftId: 1, subject: cycle, history: [] }), /No Jenkins job for this branch/);
});

test('jenkinsRebuildDraft.generate: drafts the job path once mapped', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-2', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleJenkinsJob(cycle.id, '/job/x');
  const result = await jenkinsRebuildDraft.generate({ draftId: 1, subject: getDevCycle(cycle.id)!, history: [] });
  assert.equal(result.mode, 'draft');
  assert.equal((result as any).content.jobPath, '/job/x');
});

test('jenkinsRebuildDraft.execute: triggers the build for the cycle\'s mapped job', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-3', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleJenkinsJob(cycle.id, '/job/y');
  const triggerSpy = mock.method(jenkinsClientModule, 'triggerBuild', async (jobPath: string) => {
    assert.equal(jobPath, '/job/y');
  });
  try {
    const result = await jenkinsRebuildDraft.execute('rebuild', { draft: {} as any, subject: getDevCycle(cycle.id)!, content: { jobPath: '/job/y', branchName: null } });
    assert.equal((result as any).jobPath, '/job/y');
    assert.equal(triggerSpy.mock.callCount(), 1);
  } finally {
    triggerSpy.mock.restore();
  }
});

test('jenkinsRebuildDraft.execute: throws rather than triggering when no job is mapped', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-4', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  await assert.rejects(
    () => jenkinsRebuildDraft.execute('rebuild', { draft: {} as any, subject: getDevCycle(cycle.id)!, content: { jobPath: '', branchName: null } }),
    /no Jenkins job mapped/
  );
});

test('jenkinsRebuildDraft.generate: with no per-branch job, drafts a run of the shared build-and-test job for the branch', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-5', repoName: 'officercc', repoPath: 'C:\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(cycle.id, { branchName: 'feature/PROJ-5-x', worktreePath: 'C:\wt' });
  _setConfigOverrides({ jenkinsTestJob: 'QA/Branch-Tests', jenkinsTestBranchParam: 'GIT_BRANCH' });
  try {
    const result = await jenkinsRebuildDraft.generate({ draftId: 1, subject: getDevCycle(cycle.id)!, history: [] });
    assert.deepEqual((result as any).content, {
      jobPath: '/job/QA/job/Branch-Tests',
      branchName: 'feature/PROJ-5-x',
      testJob: { fullName: 'QA/Branch-Tests', branchParam: 'GIT_BRANCH' },
    });
  } finally {
    _setConfigOverrides({});
  }
});

test('jenkinsRebuildDraft.execute: triggers the shared job with the branch as a parameter and records the queue item to follow', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-6', repoName: 'officercc', repoPath: 'C:\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  const triggerSpy = mock.method(jenkinsMcpModule, 'triggerJenkinsBuild', async (job: string, params: Record<string, string>) => {
    assert.equal(job, 'QA/Branch-Tests');
    assert.deepEqual(params, { BRANCH: 'feature/PROJ-6-y' });
    return 4242;
  });
  const restSpy = mock.method(jenkinsClientModule, 'triggerBuild', async () => {
    throw new Error('REST trigger must not be used for the shared job');
  });
  try {
    const content = { jobPath: '/job/QA/job/Branch-Tests', branchName: 'feature/PROJ-6-y', testJob: { fullName: 'QA/Branch-Tests', branchParam: 'BRANCH' } };
    const result = await jenkinsRebuildDraft.execute('rebuild', { draft: {} as any, subject: getDevCycle(cycle.id)!, content });
    assert.equal((result as any).queueId, 4242);
    const [request] = getJenkinsBuildRequestsForCycle(cycle.id);
    assert.equal(request.queueId, 4242);
    assert.equal(request.status, 'queued');
    assert.equal(request.branchName, 'feature/PROJ-6-y');
    assert.equal(request.jobFullName, 'QA/Branch-Tests');
    assert.equal(restSpy.mock.callCount(), 0);
  } finally {
    triggerSpy.mock.restore();
    restSpy.mock.restore();
  }
});

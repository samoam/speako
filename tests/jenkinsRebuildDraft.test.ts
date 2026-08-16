import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, setDevCycleJenkinsJob, getDevCycle } from '../src/storage/devCycleRepository';
import * as jenkinsClientModule from '../src/integrations/jenkinsClient';
import { jenkinsRebuildDraft } from '../src/drafts/kinds/jenkinsRebuildDraft';

test('jenkinsRebuildDraft.generate: throws when the cycle has no Jenkins job mapped yet', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-1', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  await assert.rejects(() => jenkinsRebuildDraft.generate({ draftId: 1, subject: cycle, history: [] }), /no Jenkins job mapped/);
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

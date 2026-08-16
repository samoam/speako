import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settingsStore';
import { createDevCycle, setDevCycleBranch, setDevCycleJenkinsJob, getDevCycle } from '../src/storage/devCycleRepository';
import * as devCycleRepositoryModule from '../src/storage/devCycleRepository';
import * as jenkinsClientModule from '../src/integrations/jenkinsClient';
import { pollJenkinsBuilds } from '../src/dev/jenkinsMonitor';

function seedCycleWithBranch(ticketKey: string, repoName = 'officercc') {
  const cycle = createDevCycle({ ticketKey, repoName, repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(cycle.id, { branchName: `feature/${ticketKey}-x`, worktreePath: 'C:\\worktrees\\x' });
  return getDevCycle(cycle.id)!;
}

function configureJenkins() {
  updateSettings({ jenkinsUrl: 'https://jenkins.example.com', jenkinsUser: 'madadi', jenkinsApiToken: 'tok', jenkinsJobFolders: 'officercc=Team/officercc' });
}

/** Every test seeds its own dev cycle(s), but getActiveDevCycles() is global across the whole (shared, in-memory) DB — a previous test's cycle would otherwise still be "active" and get polled here too. Mocking it to return only this test's cycle(s) is what actually isolates each test, not just cleanup ordering. */
function onlyCycle(...cycles: ReturnType<typeof seedCycleWithBranch>[]) {
  return mock.method(devCycleRepositoryModule, 'getActiveDevCycles', () => cycles);
}

test.afterEach(() => updateSettings({ jenkinsUrl: '', jenkinsUser: '', jenkinsApiToken: '', jenkinsJobFolders: '' }));

test('pollJenkinsBuilds: no-ops entirely when Jenkins is not configured', async () => {
  const result = await pollJenkinsBuilds(() => {});
  assert.deepEqual(result, { checked: 0, newFailures: 0 });
});

test('pollJenkinsBuilds: resolves and caches the job path for a cycle that has none yet', async () => {
  configureJenkins();
  const cycle = seedCycleWithBranch('PROJ-1');
  const scopeSpy = onlyCycle(cycle);
  const findSpy = mock.method(jenkinsClientModule, 'findBranchJob', async (folder: string, branch: string) => {
    assert.equal(folder, 'Team/officercc');
    assert.equal(branch, cycle.branchName);
    return '/job/Team/job/officercc/job/feature%2FPROJ-1-x';
  });
  const lastBuildSpy = mock.method(jenkinsClientModule, 'getLastBuild', async () => null);
  try {
    await pollJenkinsBuilds(() => {});
    assert.equal(getDevCycle(cycle.id)!.jenkinsJobPath, '/job/Team/job/officercc/job/feature%2FPROJ-1-x');
    assert.equal(findSpy.mock.callCount(), 1);
  } finally {
    scopeSpy.mock.restore();
    findSpy.mock.restore();
    lastBuildSpy.mock.restore();
  }
});

test('pollJenkinsBuilds: skips a cycle whose repo has no configured Jenkins folder mapping', async () => {
  configureJenkins();
  const cycle = seedCycleWithBranch('PROJ-2', 'some-other-repo');
  const scopeSpy = onlyCycle(cycle);
  try {
    const result = await pollJenkinsBuilds(() => {});
    assert.equal(result.checked, 0);
  } finally {
    scopeSpy.mock.restore();
  }
});

test('pollJenkinsBuilds: a passing build is recorded and broadcast, but not counted as a new failure', async () => {
  configureJenkins();
  const cycle = seedCycleWithBranch('PROJ-3');
  setDevCycleJenkinsJob(cycle.id, '/job/x');
  const scopeSpy = onlyCycle(getDevCycle(cycle.id)!);
  const lastBuildSpy = mock.method(jenkinsClientModule, 'getLastBuild', async () => ({
    jobPath: '/job/x', number: 5, result: 'SUCCESS', building: false, timestamp: Date.now(), durationMs: 1000, url: 'https://jenkins/5', displayName: '#5',
  }));
  const events: any[] = [];
  try {
    const result = await pollJenkinsBuilds((e) => events.push(e));
    assert.equal(result.checked, 1);
    assert.equal(result.newFailures, 0);
    assert.ok(events.some((e) => e.type === 'jenkins-build-updated' && e.result === 'SUCCESS'));
  } finally {
    scopeSpy.mock.restore();
    lastBuildSpy.mock.restore();
  }
});

test('pollJenkinsBuilds: a failing build is classified and broadcast as a new failure', async () => {
  configureJenkins();
  const cycle = seedCycleWithBranch('PROJ-4');
  setDevCycleJenkinsJob(cycle.id, '/job/y');
  const scopeSpy = onlyCycle(getDevCycle(cycle.id)!);
  const lastBuildSpy = mock.method(jenkinsClientModule, 'getLastBuild', async () => ({
    jobPath: '/job/y', number: 9, result: 'FAILURE', building: false, timestamp: Date.now(), durationMs: 1000, url: 'https://jenkins/9', displayName: '#9',
  }));
  const consoleSpy = mock.method(jenkinsClientModule, 'getConsoleTail', async () => 'error TS2339: something');
  const testReportSpy = mock.method(jenkinsClientModule, 'getTestReport', async () => null);
  const stagesSpy = mock.method(jenkinsClientModule, 'getPipelineStages', async () => []);
  const recentBuildsSpy = mock.method(jenkinsClientModule, 'getRecentBuilds', async () => []);
  const events: any[] = [];
  try {
    const result = await pollJenkinsBuilds((e) => events.push(e));
    assert.equal(result.newFailures, 1);
    const failedEvent = events.find((e) => e.type === 'jenkins-build-failed');
    assert.ok(failedEvent);
    assert.equal(failedEvent.classification, 'compile_error');
  } finally {
    scopeSpy.mock.restore();
    lastBuildSpy.mock.restore();
    consoleSpy.mock.restore();
    testReportSpy.mock.restore();
    stagesSpy.mock.restore();
    recentBuildsSpy.mock.restore();
  }
});

test('pollJenkinsBuilds: a build recovering to SUCCESS after a recorded failure broadcasts jenkins-build-recovered', async () => {
  configureJenkins();
  const cycle = seedCycleWithBranch('PROJ-5');
  setDevCycleJenkinsJob(cycle.id, '/job/z');
  const scopeSpy = onlyCycle(getDevCycle(cycle.id)!);

  const firstBuild = mock.method(jenkinsClientModule, 'getLastBuild', async () => ({
    jobPath: '/job/z', number: 1, result: 'FAILURE', building: false, timestamp: Date.now(), durationMs: 1000, url: 'https://jenkins/1', displayName: '#1',
  }));
  const consoleSpy = mock.method(jenkinsClientModule, 'getConsoleTail', async () => 'some failure');
  const testReportSpy = mock.method(jenkinsClientModule, 'getTestReport', async () => null);
  const stagesSpy = mock.method(jenkinsClientModule, 'getPipelineStages', async () => []);
  const recentBuildsSpy = mock.method(jenkinsClientModule, 'getRecentBuilds', async () => []);
  await pollJenkinsBuilds(() => {});
  firstBuild.mock.restore();
  consoleSpy.mock.restore();
  testReportSpy.mock.restore();
  stagesSpy.mock.restore();
  recentBuildsSpy.mock.restore();

  const secondBuild = mock.method(jenkinsClientModule, 'getLastBuild', async () => ({
    jobPath: '/job/z', number: 2, result: 'SUCCESS', building: false, timestamp: Date.now(), durationMs: 1000, url: 'https://jenkins/2', displayName: '#2',
  }));
  const events: any[] = [];
  try {
    await pollJenkinsBuilds((e) => events.push(e));
    assert.ok(events.some((e) => e.type === 'jenkins-build-recovered'));
  } finally {
    scopeSpy.mock.restore();
    secondBuild.mock.restore();
  }
});

test('pollJenkinsBuilds: polling the same unchanged build twice broadcasts nothing the second time', async () => {
  configureJenkins();
  const cycle = seedCycleWithBranch('PROJ-6');
  setDevCycleJenkinsJob(cycle.id, '/job/w');
  const scopeSpy = onlyCycle(getDevCycle(cycle.id)!);
  const lastBuildSpy = mock.method(jenkinsClientModule, 'getLastBuild', async () => ({
    jobPath: '/job/w', number: 3, result: 'SUCCESS', building: false, timestamp: Date.now(), durationMs: 1000, url: 'https://jenkins/3', displayName: '#3',
  }));
  try {
    await pollJenkinsBuilds(() => {});
    const secondEvents: any[] = [];
    await pollJenkinsBuilds((e) => secondEvents.push(e));
    assert.equal(secondEvents.length, 0);
  } finally {
    scopeSpy.mock.restore();
    lastBuildSpy.mock.restore();
  }
});

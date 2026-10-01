import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settingsStore';
import { createDevCycle, setDevCycleBranch, setDevCycleJenkinsJob, getDevCycle } from '../src/storage/devCycleRepository';
import * as devCycleRepositoryModule from '../src/storage/devCycleRepository';
import * as jenkinsClientModule from '../src/integrations/jenkinsClient';
import { pollJenkinsBuilds } from '../src/dev/jenkinsMonitor';
import * as jenkinsMcpModule from '../src/integrations/jenkinsMcp';
import * as buildRequestRepositoryModule from '../src/storage/jenkinsBuildRequestRepository';
import { createJenkinsBuildRequest, getJenkinsBuildRequest } from '../src/storage/jenkinsBuildRequestRepository';
import { upsertJenkinsBuild, getJenkinsBuildByJobAndNumber } from '../src/storage/jenkinsBuildRepository';

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

/** Same isolation reason as onlyCycle: open build requests are global across the shared in-memory DB. */
function onlyRequests(...ids: number[]) {
  return mock.method(buildRequestRepositoryModule, 'getOpenJenkinsBuildRequests', () => ids.map((id) => getJenkinsBuildRequest(id)!));
}

function sharedJobRequest(ticketKey: string, queueId: number) {
  const cycle = seedCycleWithBranch(ticketKey, 'no-folder-mapping');
  const request = createJenkinsBuildRequest({ devCycleId: cycle.id, jobPath: '/job/Branch-Tests', jobFullName: 'Branch-Tests', branchName: cycle.branchName!, queueId });
  return { cycle, request };
}

test('pollJenkinsBuilds: a queued shared-job run is followed to its own build number and recorded while building', async () => {
  configureJenkins();
  const { cycle, request } = sharedJobRequest('PROJ-20', 900);
  const scopeSpy = onlyCycle(cycle);
  const requestsSpy = onlyRequests(request.id);
  const queueSpy = mock.method(jenkinsMcpModule, 'getQueueState', async (id: number) => {
    assert.equal(id, 900);
    return { state: 'started', buildNumber: 31 };
  });
  const buildSpy = mock.method(jenkinsMcpModule, 'getBuildByNumber', async (job: string, n: number) => {
    assert.deepEqual([job, n], ['Branch-Tests', 31]);
    return { jobPath: '/job/Branch-Tests', number: 31, result: null, building: true, timestamp: Date.now(), durationMs: 0, url: 'https://jenkins/31', displayName: '#31' };
  });
  const events: any[] = [];
  try {
    await pollJenkinsBuilds((e) => events.push(e));
    assert.equal(getJenkinsBuildRequest(request.id)!.status, 'started');
    assert.equal(getJenkinsBuildRequest(request.id)!.buildNumber, 31);
    const row = getJenkinsBuildByJobAndNumber('/job/Branch-Tests', 31)!;
    assert.equal(row.building, true);
    assert.equal(row.devCycleId, cycle.id);
    assert.equal(row.branchName, cycle.branchName);
    assert.ok(events.some((e) => e.type === 'jenkins-build-updated' && e.buildNumber === 31));
  } finally {
    scopeSpy.mock.restore();
    requestsSpy.mock.restore();
    queueSpy.mock.restore();
    buildSpy.mock.restore();
  }
});

test('pollJenkinsBuilds: a failed shared-job run is classified using only the same branch\'s earlier builds', async () => {
  configureJenkins();
  const { cycle, request } = sharedJobRequest('PROJ-21', 901);
  // Another branch's build on the same shared job — must NOT be used as a flaky-comparison build.
  upsertJenkinsBuild({ devCycleId: null, jobPath: '/job/Branch-Tests', branchName: 'feature/OTHER-1-z', buildNumber: 40, result: 'FAILURE', building: false });
  // This branch's own earlier build — the one comparison build that should be used.
  upsertJenkinsBuild({ devCycleId: cycle.id, jobPath: '/job/Branch-Tests', branchName: cycle.branchName!, buildNumber: 38, result: 'SUCCESS', building: false });
  const scopeSpy = onlyCycle(cycle);
  const requestsSpy = onlyRequests(request.id);
  const queueSpy = mock.method(jenkinsMcpModule, 'getQueueState', async () => ({ state: 'started', buildNumber: 41 }));
  const buildSpy = mock.method(jenkinsMcpModule, 'getBuildByNumber', async () => ({
    jobPath: '/job/Branch-Tests', number: 41, result: 'UNSTABLE', building: false, timestamp: Date.now(), durationMs: 1000, url: 'https://jenkins/41', displayName: '#41',
  }));
  const reportedBuilds: number[] = [];
  const consoleSpy = mock.method(jenkinsClientModule, 'getConsoleTail', async () => 'Tests run: 10, Failures: 1');
  const reportSpy = mock.method(jenkinsClientModule, 'getTestReport', async (_job: string, n: number) => {
    reportedBuilds.push(n);
    return { total: 10, failCount: n === 41 ? 1 : 0, skipCount: 0, failures: n === 41 ? [{ className: 'a.B', name: 't', errorDetails: 'boom', errorStackTrace: null, age: 1 }] : [] };
  });
  const stagesSpy = mock.method(jenkinsClientModule, 'getPipelineStages', async () => []);
  const events: any[] = [];
  try {
    const result = await pollJenkinsBuilds((e) => events.push(e));
    assert.equal(result.newFailures, 1);
    assert.deepEqual(reportedBuilds.sort((a, b) => a - b), [38, 41]);
    assert.equal(getJenkinsBuildRequest(request.id)!.status, 'finished');
    assert.ok(getJenkinsBuildByJobAndNumber('/job/Branch-Tests', 41)!.classification);
    assert.ok(events.some((e) => e.type === 'jenkins-build-failed' && e.buildNumber === 41 && e.devCycleId === cycle.id));
  } finally {
    scopeSpy.mock.restore();
    requestsSpy.mock.restore();
    queueSpy.mock.restore();
    buildSpy.mock.restore();
    consoleSpy.mock.restore();
    reportSpy.mock.restore();
    stagesSpy.mock.restore();
  }
});

test('pollJenkinsBuilds: a run Jenkins dropped from its queue is marked lost, not left open forever', async () => {
  configureJenkins();
  const { cycle, request } = sharedJobRequest('PROJ-22', 902);
  const scopeSpy = onlyCycle(cycle);
  const requestsSpy = onlyRequests(request.id);
  const queueSpy = mock.method(jenkinsMcpModule, 'getQueueState', async () => ({ state: 'gone' }));
  const events: any[] = [];
  try {
    await pollJenkinsBuilds((e) => events.push(e));
    assert.equal(getJenkinsBuildRequest(request.id)!.status, 'lost');
    assert.ok(events.some((e) => e.type === 'jenkins-build-request-updated' && e.status === 'lost'));
  } finally {
    scopeSpy.mock.restore();
    requestsSpy.mock.restore();
    queueSpy.mock.restore();
  }
});

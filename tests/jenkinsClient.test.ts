import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { jobPathFor, isJenkinsConfigured, getTestReport } from '../src/integrations/jenkinsClient';
import { updateSettings } from '../src/settingsStore';

test.afterEach(() => updateSettings({ jenkinsUrl: '', jenkinsUser: '', jenkinsApiToken: '' }));

test('isJenkinsConfigured: false until url/user/token are all set', () => {
  assert.equal(isJenkinsConfigured(), false);
  updateSettings({ jenkinsUrl: 'https://jenkins.example.com' });
  assert.equal(isJenkinsConfigured(), false);
  updateSettings({ jenkinsUser: 'madadi' });
  assert.equal(isJenkinsConfigured(), false);
  updateSettings({ jenkinsApiToken: 'tok' });
  assert.equal(isJenkinsConfigured(), true);
});

test('jobPathFor: a plain folder path with no branch', () => {
  assert.equal(jobPathFor('Team/officercc'), '/job/Team/job/officercc');
});

test('jobPathFor: encodes a branch name\'s slashes as %2F, addressing it as one path segment', () => {
  assert.equal(jobPathFor('Team/officercc', 'feature/PROJ-1-x'), '/job/Team/job/officercc/job/feature%2FPROJ-1-x');
});

test('jobPathFor: encodes special characters in folder/branch segments', () => {
  assert.equal(jobPathFor('My Team'), '/job/My%20Team');
});

test('jobPathFor: strips empty segments from a folder path with leading/trailing/double slashes', () => {
  assert.equal(jobPathFor('/Team//officercc/'), '/job/Team/job/officercc');
});

test('getTestReport: reads a Maven job\'s per-module childReports, not just top-level suites', async () => {
  updateSettings({ jenkinsUrl: 'https://jenkins.example.com', jenkinsUser: 'u', jenkinsApiToken: 't' });
  // Shape confirmed live on a real hudson.maven.MavenModuleSetBuild: no top-level suites at all.
  const body = {
    totalCount: 633,
    failCount: 1,
    skipCount: 2,
    childReports: [
      { result: { suites: [{ cases: [{ className: 'com.x.Ok', name: 'ok', status: 'PASSED', age: 0 }] }] } },
      { result: { suites: [{ cases: [{ className: 'com.gti.cc.IntegrationTestSuite', name: 'com.gti.cc.IntegrationTestSuite', status: 'FAILED', errorDetails: 'boom', age: 2 }] }] } },
    ],
  };
  const fetchSpy = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  try {
    const report = await getTestReport('/job/ETICK-9298', 4);
    assert.equal(report!.failCount, 1);
    assert.deepEqual(report!.failures.map((f) => [f.className, f.age]), [['com.gti.cc.IntegrationTestSuite', 2]]);
    assert.match(String((fetchSpy.mock.calls[0].arguments as any[])[0]), /childReports/);
  } finally {
    fetchSpy.mock.restore();
  }
});

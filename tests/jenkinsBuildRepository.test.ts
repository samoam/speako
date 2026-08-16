import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertJenkinsBuild,
  getJenkinsBuild,
  getJenkinsBuildByJobAndNumber,
  getLatestBuildForJob,
  getRecentBuildsForJob,
  setBuildClassification,
  markBuildNotified,
  getUnnotifiedFailures,
} from '../src/storage/jenkinsBuildRepository';

test('upsertJenkinsBuild: inserts a new (job_path, build_number) row', () => {
  const build = upsertJenkinsBuild({ jobPath: '/job/a/job/b', buildNumber: 1, result: null, building: true, url: 'https://jenkins/1' });
  assert.equal(build.jobPath, '/job/a/job/b');
  assert.equal(build.buildNumber, 1);
  assert.equal(build.building, true);
  assert.equal(build.result, null);
  assert.deepEqual(getJenkinsBuildByJobAndNumber('/job/a/job/b', 1), build);
});

test('upsertJenkinsBuild: re-polling the same (job_path, build_number) updates in place rather than duplicating', () => {
  upsertJenkinsBuild({ jobPath: '/job/c', buildNumber: 5, result: null, building: true });
  const updated = upsertJenkinsBuild({ jobPath: '/job/c', buildNumber: 5, result: 'SUCCESS', building: false, url: 'https://jenkins/5' });
  assert.equal(updated.result, 'SUCCESS');
  assert.equal(updated.building, false);
  assert.equal(updated.url, 'https://jenkins/5');

  // Still exactly one row for this (job_path, build_number).
  const byId = getJenkinsBuild(updated.id)!;
  assert.equal(byId.id, updated.id);
});

test('getLatestBuildForJob: returns the highest build_number for a job', () => {
  upsertJenkinsBuild({ jobPath: '/job/d', buildNumber: 1, result: 'SUCCESS', building: false });
  upsertJenkinsBuild({ jobPath: '/job/d', buildNumber: 3, result: 'FAILURE', building: false });
  upsertJenkinsBuild({ jobPath: '/job/d', buildNumber: 2, result: 'SUCCESS', building: false });

  const latest = getLatestBuildForJob('/job/d');
  assert.equal(latest?.buildNumber, 3);
  assert.equal(latest?.result, 'FAILURE');
});

test('getRecentBuildsForJob: returns up to `limit` builds, most recent first', () => {
  for (let n = 1; n <= 5; n++) {
    upsertJenkinsBuild({ jobPath: '/job/e', buildNumber: n, result: 'SUCCESS', building: false });
  }
  const recent = getRecentBuildsForJob('/job/e', 3);
  assert.deepEqual(
    recent.map((b) => b.buildNumber),
    [5, 4, 3]
  );
});

test('setBuildClassification / markBuildNotified / getUnnotifiedFailures', () => {
  const build = upsertJenkinsBuild({ jobPath: '/job/f', buildNumber: 1, result: 'FAILURE', building: false });
  setBuildClassification(build.id, {
    classification: 'test_regression',
    classificationJson: { category: 'test_regression', confidence: 0.8, summary: 'x', suspectFiles: [], suspectTests: [], fixable: true, suggestedFix: 'y', evidence: [] },
    logExcerpt: 'AssertionError: expected 1 to equal 2',
  });
  const classified = getJenkinsBuild(build.id)!;
  assert.equal(classified.classification, 'test_regression');
  assert.equal(classified.classificationJson.confidence, 0.8);
  assert.equal(classified.logExcerpt, 'AssertionError: expected 1 to equal 2');

  const unnotified = getUnnotifiedFailures();
  assert.ok(unnotified.some((b) => b.id === build.id));

  markBuildNotified(build.id);
  const stillUnnotified = getUnnotifiedFailures();
  assert.ok(!stillUnnotified.some((b) => b.id === build.id));

  // A SUCCESS build must never show up as an unnotified failure.
  const success = upsertJenkinsBuild({ jobPath: '/job/g', buildNumber: 1, result: 'SUCCESS', building: false });
  assert.ok(!getUnnotifiedFailures().some((b) => b.id === success.id));
});

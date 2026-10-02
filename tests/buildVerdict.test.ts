import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUnstableBuild } from '../src/dev/buildVerdict';
import { JenkinsTestReport } from '../src/integrations/jenkinsClient';

const failure = (className: string, name: string, age: number) => ({ className, name, errorDetails: null, errorStackTrace: null, age });
const report = (failures: ReturnType<typeof failure>[]): JenkinsTestReport => ({ total: 100, failCount: failures.length, skipCount: 0, failures });

test('assessUnstableBuild: failures already failing before this build (age > 1) pass', () => {
  const verdict = assessUnstableBuild(report([failure('a.FooTest', 'x', 5), failure('a.BarTest', 'y', 2)]), []);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.preexistingFailures, ['a.FooTest.x', 'a.BarTest.y']);
  assert.deepEqual(verdict.newFailures, []);
  assert.match(verdict.reason, /2 pre-existing failure\(s\), none new/);
});

test('assessUnstableBuild: a failure new to this build (age 1) that no recent build had fails the verdict and is named', () => {
  const verdict = assessUnstableBuild(report([failure('a.FooTest', 'x', 5), failure('a.NewTest', 'broken', 1)]), [report([failure('a.FooTest', 'x', 4)])]);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.newFailures, ['a.NewTest.broken']);
  assert.deepEqual(verdict.preexistingFailures, ['a.FooTest.x']);
  assert.match(verdict.reason, /1 new test failure\(s\): a\.NewTest\.broken/);
});

test('assessUnstableBuild: an age-1 failure that a recent build (another branch on the shared job) also had counts as pre-existing', () => {
  const verdict = assessUnstableBuild(report([failure('a.FlakyTest', 'z', 1)]), [report([]), report([failure('a.FlakyTest', 'z', 1)])]);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.preexistingFailures, ['a.FlakyTest.z']);
});

test('assessUnstableBuild: no test report at all cannot be judged — fails', () => {
  const verdict = assessUnstableBuild(null, []);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /no test report/);
});

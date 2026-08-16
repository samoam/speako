import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { extractSignals, classifyByHeuristics, classifyBuildFailure } from '../src/dev/buildFailureClassification';
import { JenkinsTestReport, JenkinsStage } from '../src/integrations/jenkinsClient';

function report(overrides: Partial<JenkinsTestReport> = {}): JenkinsTestReport {
  return { total: 10, failCount: 0, skipCount: 0, failures: [], ...overrides };
}

test('extractSignals + classifyByHeuristics: infra_failure signature wins even amid other noise', () => {
  const log = 'Some build output\nAgent went offline during build\nmore output';
  const signals = extractSignals(log, null, [], []);
  assert.equal(classifyByHeuristics(signals), 'infra_failure');
});

test('extractSignals + classifyByHeuristics: compile_error from a TypeScript error signature', () => {
  const log = 'src/foo.ts(10,5): error TS2339: Property does not exist.\nBuild step failed.';
  const signals = extractSignals(log, null, [], []);
  assert.equal(classifyByHeuristics(signals), 'compile_error');
});

test('extractSignals + classifyByHeuristics: lint_error from an ESLint summary line', () => {
  const log = 'ESLint found 3 problems (3 errors, 0 warnings)';
  const signals = extractSignals(log, null, [], []);
  assert.equal(classifyByHeuristics(signals), 'lint_error');
});

test('extractSignals + classifyByHeuristics: a newly-failing test with no flaky history -> test_regression', () => {
  const currentReport = report({ failCount: 1, failures: [{ className: 'FooTest', name: 'testBar', errorDetails: 'assert failed', errorStackTrace: null, age: 1 }] });
  const signals = extractSignals('some log', currentReport, [], []);
  assert.deepEqual(signals.newlyFailingTests, ['FooTest.testBar']);
  assert.equal(classifyByHeuristics(signals), 'test_regression');
});

test('extractSignals + classifyByHeuristics: a failing test that also failed in a recent build -> flaky_test, never test_regression', () => {
  const currentReport = report({ failCount: 1, failures: [{ className: 'FooTest', name: 'testBar', errorDetails: null, errorStackTrace: null, age: 3 }] });
  const recentReport = report({ failCount: 1, failures: [{ className: 'FooTest', name: 'testBar', errorDetails: null, errorStackTrace: null, age: 1 }] });
  const signals = extractSignals('some log', currentReport, [], [recentReport]);
  assert.deepEqual(signals.historicallyFlakyTests, ['FooTest.testBar']);
  assert.equal(classifyByHeuristics(signals), 'flaky_test');
});

test('extractSignals: failedBeforeTestStage is true when a non-test stage fails before any test stage', () => {
  const stages: JenkinsStage[] = [
    { name: 'Build', status: 'FAILED', durationMs: 100 },
    { name: 'Test', status: 'NOT_EXECUTED', durationMs: 0 },
  ];
  const signals = extractSignals('BUILD FAILURE', null, stages, []);
  assert.equal(signals.failedBeforeTestStage, true);
  assert.equal(classifyByHeuristics(signals), 'compile_error');
});

test('extractSignals: caps pattern matches at 20 so one very noisy log cannot blow up the result', () => {
  const log = Array.from({ length: 50 }, () => 'console.log statement here').join('\n');
  // console.log isn't one of the classification patterns, so use a real one repeated.
  const noisyLog = Array.from({ length: 50 }, () => 'Connection refused').join('\n');
  const signals = extractSignals(noisyLog, null, [], []);
  assert.ok(signals.matched.length <= 20);
  void log;
});

test('classifyByHeuristics: no failures and nothing matched -> unknown', () => {
  const signals = extractSignals('everything looks fine', report({ failCount: 0 }), [], []);
  assert.equal(classifyByHeuristics(signals), 'unknown');
});

test('classifyBuildFailure: falls back to the heuristic category when Gemini is not configured', async () => {
  const currentReport = report({ failCount: 1, failures: [{ className: 'FooTest', name: 'testBar', errorDetails: null, errorStackTrace: null, age: 1 }] });
  const signals = extractSignals('AssertionError', currentReport, [], []);
  const analysis = await classifyBuildFailure({ log: 'AssertionError', signals, stages: [], report: currentReport, branch: 'feature/PROJ-1-x', ticketKey: 'PROJ-1' });
  assert.equal(analysis.category, 'test_regression');
  assert.equal(analysis.fixable, true);
  assert.equal(analysis.confidence, 0.4);
});

test('classifyBuildFailure: uses Gemini\'s classification when configured, forcing fixable=false for infra_failure', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          category: 'infra_failure',
          confidence: 0.9,
          summary: 'The build agent went offline mid-build.',
          suspectFiles: [],
          suspectTests: [],
          fixable: false,
          suggestedFix: '',
          evidence: ['Agent went offline'],
        }),
      }),
    },
  }));
  try {
    const signals = extractSignals('Agent went offline', null, [], []);
    const analysis = await classifyBuildFailure({ log: 'Agent went offline', signals, stages: [], report: null, branch: 'feature/PROJ-2-x', ticketKey: 'PROJ-2' });
    assert.equal(analysis.category, 'infra_failure');
    assert.equal(analysis.fixable, false);
    assert.equal(analysis.confidence, 0.9);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

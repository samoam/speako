import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, setDevCycleBranch, getDevCycle } from '../src/storage/devCycleRepository';
import { upsertJenkinsBuild, setBuildClassification, getJenkinsBuildByJobAndNumber } from '../src/storage/jenkinsBuildRepository';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import * as codeChangePollerModule from '../src/integrations/codeChangePoller';
import { getCodeChangeRequestsForDevCycle } from '../src/storage/codeChangeRequestRepository';
import { jenkinsFixDraft } from '../src/drafts/kinds/jenkinsFixDraft';
import { buildFixPrompt } from '../src/dev/buildFixPrompt';
import { BuildFailureAnalysis } from '../src/dev/buildFailureClassification';

function fixableAnalysis(overrides: Partial<BuildFailureAnalysis> = {}): BuildFailureAnalysis {
  return {
    category: 'test_regression', confidence: 0.8, summary: 'A test broke.', suspectFiles: ['src/foo.ts'], suspectTests: ['FooTest.testBar'],
    fixable: true, suggestedFix: 'Fix the null check.', evidence: ['AssertionError: expected 1 to equal 2'], ...overrides,
  };
}

function seedFixableBuild(jobPath: string, ticketKey: string, analysis: BuildFailureAnalysis = fixableAnalysis()) {
  const cycle = createDevCycle({ ticketKey, repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(cycle.id, { branchName: `feature/${ticketKey}-x`, worktreePath: 'C:\\worktrees\\x' });
  const build = upsertJenkinsBuild({ devCycleId: cycle.id, jobPath, branchName: `feature/${ticketKey}-x`, buildNumber: 7, result: 'FAILURE', building: false, url: 'https://jenkins/7' });
  setBuildClassification(build.id, { classification: analysis.category, classificationJson: analysis, logExcerpt: 'log' });
  return { cycle: getDevCycle(cycle.id)!, build: getJenkinsBuildByJobAndNumber(jobPath, 7)! };
}

test('buildFixPrompt: embeds the classification details and the never-weaken-tests guard', () => {
  const prompt = buildFixPrompt({ branch: 'feature/PROJ-1-x', buildNumber: 7, analysis: fixableAnalysis(), ticketKey: 'PROJ-1' });
  assert.match(prompt, /Build #7 on branch feature\/PROJ-1-x failed \(ticket PROJ-1\)/);
  assert.match(prompt, /FooTest\.testBar/);
  assert.match(prompt, /Fix the null check\./);
  assert.match(prompt, /do not weaken or delete the failing assertion/);
});

test('jenkinsFixDraft.loadSubject: parses "<jobPath>#<buildNumber>" and resolves the build + its dev cycle', async () => {
  const { cycle, build } = seedFixableBuild('/job/x', 'PROJ-2');
  const subject = await jenkinsFixDraft.loadSubject(`/job/x#${build.buildNumber}`);
  assert.equal(subject?.build.id, build.id);
  assert.equal(subject?.cycle.id, cycle.id);
});

test('jenkinsFixDraft.loadSubject: undefined for a build with no dev cycle attached', async () => {
  const build = upsertJenkinsBuild({ jobPath: '/job/y', buildNumber: 1, result: 'FAILURE', building: false });
  assert.equal(await jenkinsFixDraft.loadSubject(`/job/y#${build.buildNumber}`), undefined);
});

test('jenkinsFixDraft.generate: refuses to propose a fix for a non-fixable classification', async () => {
  const { cycle, build } = seedFixableBuild('/job/z', 'PROJ-3', fixableAnalysis({ category: 'infra_failure', fixable: false }));
  await assert.rejects(() => jenkinsFixDraft.generate({ draftId: 1, subject: { build, cycle }, history: [] }), /isn't something a code fix can address/);
});

test('jenkinsFixDraft.generate: drafts a scoped fix prompt for a fixable classification', async () => {
  const { cycle, build } = seedFixableBuild('/job/w', 'PROJ-4');
  const result = await jenkinsFixDraft.generate({ draftId: 1, subject: { build, cycle }, history: [] });
  assert.equal(result.mode, 'draft');
  assert.match((result as any).content.prompt, /FooTest\.testBar/);
  assert.equal((result as any).content.category, 'test_regression');
});

test('jenkinsFixDraft.generate: a redo appends context about the failed prior attempt', async () => {
  const { cycle, build } = seedFixableBuild('/job/v', 'PROJ-5');
  const result = await jenkinsFixDraft.generate({
    draftId: 1,
    subject: { build, cycle },
    history: [],
    redo: { priorContent: { prompt: 'original prompt' }, priorResultRef: {}, priorHistory: [], observed: '', strategy: 'fresh', instruction: 'the null check was in the wrong place' },
  });
  assert.match((result as any).content.prompt, /original prompt/);
  assert.match((result as any).content.prompt, /the null check was in the wrong place/);
});

test('jenkinsFixDraft.execute: dispatches the fix agent and records a code_change_requests row scoped to the cycle', async () => {
  const { cycle, build } = seedFixableBuild('/job/u', 'PROJ-6');
  const startSpy = mock.method(claudeCodeCliModule, 'startClaudeCodeTask', async (prompt: string, repoPath: string) => {
    assert.equal(repoPath, cycle.worktreePath);
    assert.equal(prompt, 'fix this'); // execute() passes ctx.content.prompt straight through to the agent, verbatim
    return { cliSessionId: 'fix-session' };
  });
  const pollSpy = mock.method(codeChangePollerModule, 'pollCodeChangeRequest', async () => {});
  try {
    const result = await jenkinsFixDraft.execute('fix', { draft: {} as any, subject: { build, cycle }, content: { prompt: 'fix this', summary: 's', category: 'test_regression', suspectFiles: [], suspectTests: [] } });
    assert.equal((result as any).cliSessionId, 'fix-session');
    const requests = getCodeChangeRequestsForDevCycle(cycle.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, 'jenkins_fix');
    assert.equal(requests[0].repoPath, cycle.worktreePath);
    assert.equal(pollSpy.mock.callCount(), 1);
  } finally {
    startSpy.mock.restore();
    pollSpy.mock.restore();
  }
});

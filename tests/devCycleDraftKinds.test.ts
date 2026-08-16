import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle, setDevCycleBranch } from '../src/storage/devCycleRepository';
import { getCodeChangeRequestsForDevCycle } from '../src/storage/codeChangeRequestRepository';
import * as jiraMcpModule from '../src/integrations/jiraMcp';
import * as gitBranchesModule from '../src/integrations/gitBranches';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import * as codeChangePollerModule from '../src/integrations/codeChangePoller';
import * as draftServiceModule from '../src/drafts/draftService';
import { gitBranchCreateDraft } from '../src/drafts/kinds/gitBranchCreateDraft';
import { devPlanDraft } from '../src/drafts/kinds/devPlanDraft';
import * as devPlanModule from '../src/dev/devPlan';

function seedCycle(ticketKey: string) {
  return createDevCycle({ ticketKey, repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'Dev Ready' });
}

test('gitBranchCreateDraft.generate: builds a branch name from the ticket summary via the naming convention', async () => {
  const cycle = seedCycle('PROJ-1');
  const spy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-1', summary: 'Add OAuth refresh', description: '', status: 'Dev Ready' }));
  try {
    const result = await gitBranchCreateDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.branchName, 'feature/PROJ-1-add-oauth-refresh');
    assert.equal((result as any).content.baseBranch, 'main');
  } finally {
    spy.mock.restore();
  }
});

test('gitBranchCreateDraft.execute: creates the worktree, records the branch, and auto-starts the Jira transition + plan drafts', async () => {
  const cycle = seedCycle('PROJ-2');
  const worktreeSpy = mock.method(gitBranchesModule, 'createTicketBranchWorktree', async () => 'C:\\worktrees\\proj2');
  const startDraftSpy = mock.method(draftServiceModule, 'startDraft', async () => ({}) as any);
  try {
    const result = await gitBranchCreateDraft.execute('create', {
      draft: {} as any,
      subject: cycle,
      content: { branchName: 'feature/PROJ-2-do-thing', baseBranch: 'main' },
    });
    assert.equal((result as any).branchName, 'feature/PROJ-2-do-thing');
    assert.equal((result as any).worktreePath, 'C:\\worktrees\\proj2');

    const updated = getDevCycle(cycle.id)!;
    assert.equal(updated.branchName, 'feature/PROJ-2-do-thing');
    assert.equal(updated.worktreePath, 'C:\\worktrees\\proj2');
    // lifecycleState is only updated once the Jira transition draft is
    // actually approved+applied (jiraTransitionDraft.execute) — never
    // written directly here, since every Jira write must be gated.
    assert.equal(updated.lifecycleState, 'Dev Ready');

    assert.equal(startDraftSpy.mock.callCount(), 2);
    assert.deepEqual(startDraftSpy.mock.calls[0].arguments[0], { kind: 'jira_transition', subjectId: `${cycle.id}:In Progress` });
    assert.deepEqual(startDraftSpy.mock.calls[1].arguments[0], { kind: 'dev_plan', subjectId: cycle.id });
  } finally {
    worktreeSpy.mock.restore();
    startDraftSpy.mock.restore();
  }
});

test('gitBranchCreateDraft.execute: throws (not silently succeeds) when no branch name is given', async () => {
  const cycle = seedCycle('PROJ-3');
  await assert.rejects(
    () => gitBranchCreateDraft.execute('create', { draft: {} as any, subject: cycle, content: { branchName: '', baseBranch: 'main' } }),
    /branch name is required/
  );
});

test('devPlanDraft.generate: throws a clear error if the cycle has no branch yet', async () => {
  const cycle = seedCycle('PROJ-4');
  await assert.rejects(() => devPlanDraft.generate({ draftId: 1, subject: cycle, history: [] }), /create the branch first/);
});

test('devPlanDraft.generate: gathers context, runs the plan agent, and returns its structured output', async () => {
  const cycle = seedCycle('PROJ-5');
  setDevCycleBranch(cycle.id, { branchName: 'feature/PROJ-5-x', worktreePath: 'C:\\worktrees\\proj5' });
  const withBranch = getDevCycle(cycle.id)!;

  const contextSpy = mock.method(devPlanModule, 'gatherPlanContext', async () => ({ ticket: { key: 'PROJ-5', summary: 'x', description: '', status: 'Dev Ready' }, confluencePages: [], codeHits: [] }));
  const plan = { understanding: 'u', approach: 'a', files: [], tests: [], risks: [], openQuestions: [], estimatedSize: 's' as const };
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async (_prompt: string, worktreePath: string) => {
    assert.equal(worktreePath, 'C:\\worktrees\\proj5');
    return { resultText: '', structuredOutput: plan, isError: false, costUsd: 0 };
  });
  try {
    const result = await devPlanDraft.generate({ draftId: 1, subject: withBranch, history: [] });
    assert.equal(result.mode, 'draft');
    assert.deepEqual((result as any).content, plan);
  } finally {
    contextSpy.mock.restore();
    reviewSpy.mock.restore();
  }
});

test('devPlanDraft.generate: surfaces the agent\'s error rather than silently returning an empty plan', async () => {
  const cycle = seedCycle('PROJ-6');
  setDevCycleBranch(cycle.id, { branchName: 'feature/PROJ-6-x', worktreePath: 'C:\\worktrees\\proj6' });
  const withBranch = getDevCycle(cycle.id)!;

  const contextSpy = mock.method(devPlanModule, 'gatherPlanContext', async () => ({ ticket: { key: 'PROJ-6', summary: 'x', description: '', status: 'Dev Ready' }, confluencePages: [], codeHits: [] }));
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async () => ({ resultText: 'agent crashed', structuredOutput: null, isError: true, costUsd: 0 }));
  try {
    await assert.rejects(() => devPlanDraft.generate({ draftId: 1, subject: withBranch, history: [] }), /agent crashed/);
  } finally {
    contextSpy.mock.restore();
    reviewSpy.mock.restore();
  }
});

test('devPlanDraft.execute: dispatches the implementation agent and records a code_change_requests row targeting the cycle\'s own worktree', async () => {
  const cycle = seedCycle('PROJ-7');
  setDevCycleBranch(cycle.id, { branchName: 'feature/PROJ-7-x', worktreePath: 'C:\\worktrees\\proj7' });
  const withBranch = getDevCycle(cycle.id)!;
  const plan = { understanding: 'u', approach: 'a', files: [], tests: [], risks: [], openQuestions: [], estimatedSize: 's' as const };

  const startSpy = mock.method(claudeCodeCliModule, 'startClaudeCodeTask', async (_prompt: string, repoPath: string) => {
    assert.equal(repoPath, 'C:\\worktrees\\proj7');
    return { cliSessionId: 'session-abc' };
  });
  const pollSpy = mock.method(codeChangePollerModule, 'pollCodeChangeRequest', async () => {});
  try {
    const result = await devPlanDraft.execute('approve', { draft: {} as any, subject: withBranch, content: plan });
    assert.equal((result as any).cliSessionId, 'session-abc');

    const requests = getCodeChangeRequestsForDevCycle(cycle.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, 'dev_plan');
    assert.equal(requests[0].repoPath, 'C:\\worktrees\\proj7');
    assert.equal(requests[0].cliSessionId, 'session-abc');
    assert.equal(pollSpy.mock.callCount(), 1);
  } finally {
    startSpy.mock.restore();
    pollSpy.mock.restore();
  }
});

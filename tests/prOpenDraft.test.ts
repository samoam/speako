import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle, setDevCycleBranch } from '../src/storage/devCycleRepository';
import { createDraft } from '../src/storage/draftRepository';
import { updateSettings } from '../src/settingsStore';
import * as jiraMcpModule from '../src/integrations/jiraMcp';
import * as gitBranchesModule from '../src/integrations/gitBranches';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import * as bitbucketServerModule from '../src/integrations/bitbucketServer';
import * as draftServiceModule from '../src/drafts/draftService';
import { prOpenDraft } from '../src/drafts/kinds/prOpenDraft';

function seedCycleWithBranch(ticketKey: string) {
  const cycle = createDevCycle({ ticketKey, repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(cycle.id, { branchName: `feature/${ticketKey}-x`, worktreePath: 'C:\\worktrees\\x' });
  return getDevCycle(cycle.id)!;
}

test.afterEach(() => updateSettings({ bitbucketServerRepos: '', jiraUrl: '' }));

test('prOpenDraft.generate: throws if the cycle has no branch yet', async () => {
  const cycle = createDevCycle({ ticketKey: 'PROJ-1', repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'Dev Ready' });
  await assert.rejects(() => prOpenDraft.generate({ draftId: 1, subject: cycle, history: [] }), /no branch yet/);
});

test('prOpenDraft.generate: builds a title/description and runs the self-review checklist', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com' });
  const cycle = seedCycleWithBranch('PROJ-2');

  const ticketSpy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-2', summary: 'Add caching', description: 'Cache responses.', status: 'In Progress' }));
  const statSpy = mock.method(gitBranchesModule, 'getBranchDiffStat', async () => ({ files: ['src/cache.ts'], insertions: 20, deletions: 0 }));
  const diffSpy = mock.method(gitBranchesModule, 'getBranchDiff', async () => '+++ b/src/cache.ts\n+const x = 1;\n');
  const gitSpy = mock.method(claudeCodeCliModule, 'git', async () => '0\n');
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async () => ({
    resultText: '',
    isError: false,
    costUsd: 0,
    structuredOutput: { acceptanceCriteria: [], scopeCreep: [], testGaps: [], splitSuggestion: { shouldSplit: false, rationale: '', proposedSplits: [] }, verdict: 'ready', summary: 'Looks good.' },
  }));
  try {
    const result = await prOpenDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal(result.mode, 'draft');
    const content = (result as any).content;
    assert.equal(content.title, 'PROJ-2: Add caching');
    // No dev_plan draft exists for this cycle in this test, so the
    // description's "What & why"/"Approach" sections are correctly omitted —
    // only the ticket-link section (which cites the key, not the summary) is guaranteed.
    assert.match(content.description, /PROJ-2/);
    assert.equal(content.checks.agent.verdict, 'ready');
    assert.equal(content.fromBranch, cycle.branchName);
    assert.equal(content.toBranch, 'main');
  } finally {
    ticketSpy.mock.restore();
    statSpy.mock.restore();
    diffSpy.mock.restore();
    gitSpy.mock.restore();
    reviewSpy.mock.restore();
  }
});

function agentResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    acceptanceCriteria: [], scopeCreep: [], testGaps: [], splitSuggestion: { shouldSplit: false, rationale: '', proposedSplits: [] },
    verdict: 'ready', summary: 'Looks good.', confluenceRelevant: false, confluenceReason: 'Routine change.', ...overrides,
  };
}

test('prOpenDraft.generate: auto-triggers a confluence_dev_cycle_update draft when the self-review agent judges the change documentation-worthy', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com' });
  const cycle = seedCycleWithBranch('PROJ-7');

  const ticketSpy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-7', summary: 'Add caching', description: '', status: 'In Progress' }));
  const statSpy = mock.method(gitBranchesModule, 'getBranchDiffStat', async () => ({ files: [], insertions: 0, deletions: 0 }));
  const diffSpy = mock.method(gitBranchesModule, 'getBranchDiff', async () => '');
  const gitSpy = mock.method(claudeCodeCliModule, 'git', async () => '0\n');
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async () => ({
    resultText: '', isError: false, costUsd: 0,
    structuredOutput: agentResult({ confluenceRelevant: true, confluenceReason: 'Changes public API behavior.' }),
  }));
  const startDraftSpy = mock.method(draftServiceModule, 'startDraft', async () => ({}) as any);
  try {
    await prOpenDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal(startDraftSpy.mock.callCount(), 1);
    assert.deepEqual(startDraftSpy.mock.calls[0]!.arguments[0], { kind: 'confluence_dev_cycle_update', subjectId: String(cycle.id) });
  } finally {
    ticketSpy.mock.restore();
    statSpy.mock.restore();
    diffSpy.mock.restore();
    gitSpy.mock.restore();
    reviewSpy.mock.restore();
    startDraftSpy.mock.restore();
  }
});

test('prOpenDraft.generate: does not auto-trigger when the self-review agent judges the change not documentation-worthy', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com' });
  const cycle = seedCycleWithBranch('PROJ-8');

  const ticketSpy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-8', summary: 'Fix typo', description: '', status: 'In Progress' }));
  const statSpy = mock.method(gitBranchesModule, 'getBranchDiffStat', async () => ({ files: [], insertions: 0, deletions: 0 }));
  const diffSpy = mock.method(gitBranchesModule, 'getBranchDiff', async () => '');
  const gitSpy = mock.method(claudeCodeCliModule, 'git', async () => '0\n');
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async () => ({
    resultText: '', isError: false, costUsd: 0, structuredOutput: agentResult({ confluenceRelevant: false }),
  }));
  const startDraftSpy = mock.method(draftServiceModule, 'startDraft', async () => ({}) as any);
  try {
    await prOpenDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal(startDraftSpy.mock.callCount(), 0);
  } finally {
    ticketSpy.mock.restore();
    statSpy.mock.restore();
    diffSpy.mock.restore();
    gitSpy.mock.restore();
    reviewSpy.mock.restore();
    startDraftSpy.mock.restore();
  }
});

test('prOpenDraft.generate: does not auto-trigger a second confluence draft once one already exists for this cycle', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com' });
  const cycle = seedCycleWithBranch('PROJ-9');
  createDraft({ kind: 'confluence_dev_cycle_update', subjectKind: 'dev_cycle', subjectId: cycle.id });

  const ticketSpy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-9', summary: 'Add caching', description: '', status: 'In Progress' }));
  const statSpy = mock.method(gitBranchesModule, 'getBranchDiffStat', async () => ({ files: [], insertions: 0, deletions: 0 }));
  const diffSpy = mock.method(gitBranchesModule, 'getBranchDiff', async () => '');
  const gitSpy = mock.method(claudeCodeCliModule, 'git', async () => '0\n');
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async () => ({
    resultText: '', isError: false, costUsd: 0, structuredOutput: agentResult({ confluenceRelevant: true }),
  }));
  const startDraftSpy = mock.method(draftServiceModule, 'startDraft', async () => ({}) as any);
  try {
    await prOpenDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal(startDraftSpy.mock.callCount(), 0);
  } finally {
    ticketSpy.mock.restore();
    statSpy.mock.restore();
    diffSpy.mock.restore();
    gitSpy.mock.restore();
    reviewSpy.mock.restore();
    startDraftSpy.mock.restore();
  }
});

test('prOpenDraft.generate: auto-picks the Bitbucket project/repo when exactly one is configured', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', bitbucketServerRepos: 'PROJ/officercc' });
  const cycle = seedCycleWithBranch('PROJ-3');

  const ticketSpy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-3', summary: 'x', description: '', status: 'In Progress' }));
  const statSpy = mock.method(gitBranchesModule, 'getBranchDiffStat', async () => ({ files: [], insertions: 0, deletions: 0 }));
  const diffSpy = mock.method(gitBranchesModule, 'getBranchDiff', async () => '');
  const gitSpy = mock.method(claudeCodeCliModule, 'git', async () => '0\n');
  const reviewSpy = mock.method(claudeCodeCliModule, 'runClaudeCodeReview', async () => ({ resultText: '', isError: true, costUsd: 0, structuredOutput: null }));
  try {
    const result = await prOpenDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal((result as any).content.projectKey, 'PROJ');
    assert.equal((result as any).content.repoSlug, 'officercc');
    assert.equal((result as any).content.checks.agent, null);
  } finally {
    ticketSpy.mock.restore();
    statSpy.mock.restore();
    diffSpy.mock.restore();
    gitSpy.mock.restore();
    reviewSpy.mock.restore();
  }
});

test('prOpenDraft.execute: refuses when the branch has not been pushed yet', async () => {
  const cycle = seedCycleWithBranch('PROJ-4');
  const remoteSpy = mock.method(gitBranchesModule, 'branchExistsOnRemote', async () => false);
  try {
    await assert.rejects(
      () => prOpenDraft.execute('open', { draft: {} as any, subject: cycle, content: { title: 't', description: 'd', projectKey: 'PROJ', repoSlug: 'r', fromBranch: cycle.branchName, toBranch: 'main', reviewers: [], checks: { deterministic: [], agent: null }, overridden: false } }),
      /hasn't been pushed/
    );
  } finally {
    remoteSpy.mock.restore();
  }
});

test('prOpenDraft.execute: refuses a blocked verdict unless overridden', async () => {
  const cycle = seedCycleWithBranch('PROJ-5');
  const remoteSpy = mock.method(gitBranchesModule, 'branchExistsOnRemote', async () => true);
  try {
    await assert.rejects(
      () =>
        prOpenDraft.execute('open', {
          draft: {} as any,
          subject: cycle,
          content: {
            title: 't', description: 'd', projectKey: 'PROJ', repoSlug: 'r', fromBranch: cycle.branchName, toBranch: 'main', reviewers: [],
            checks: { deterministic: [], agent: { acceptanceCriteria: [], scopeCreep: [], testGaps: [], splitSuggestion: { shouldSplit: false, rationale: '', proposedSplits: [] }, verdict: 'blocked', summary: 'Missing X.' } },
            overridden: false,
          },
        }),
      /blocking issue/
    );
  } finally {
    remoteSpy.mock.restore();
  }
});

test('prOpenDraft.execute: opens the PR, records it on the cycle, and refuses a second PR for the same cycle', async () => {
  const cycle = seedCycleWithBranch('PROJ-6');
  const remoteSpy = mock.method(gitBranchesModule, 'branchExistsOnRemote', async () => true);
  const createSpy = mock.method(bitbucketServerModule, 'createPullRequest', async (input: any) => {
    assert.equal(input.fromBranch, cycle.branchName);
    assert.equal(input.toBranch, 'main');
    return { id: 101, title: input.title, state: 'OPEN', projectKey: 'PROJ', repoSlug: 'r', authorName: 'me', link: 'https://bitbucket/pr/101', createdDate: null, description: null, fromRefDisplayId: null, toRefDisplayId: null };
  });
  try {
    const content = { title: 't', description: 'd', projectKey: 'PROJ', repoSlug: 'r', fromBranch: cycle.branchName, toBranch: 'main', reviewers: ['alice'], checks: { deterministic: [], agent: null }, overridden: false };
    const result = await prOpenDraft.execute('open', { draft: {} as any, subject: cycle, content });
    assert.equal((result as any).prId, 101);
    assert.equal((result as any).prUrl, 'https://bitbucket/pr/101');

    const updated = getDevCycle(cycle.id)!;
    assert.equal(updated.prId, 101);
    assert.equal(updated.prUrl, 'https://bitbucket/pr/101');

    await assert.rejects(() => prOpenDraft.execute('open', { draft: {} as any, subject: updated, content }), /already has an open PR/);
  } finally {
    remoteSpy.mock.restore();
    createSpy.mock.restore();
  }
});

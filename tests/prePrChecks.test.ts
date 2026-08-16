import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settingsStore';
import * as gitBranchesModule from '../src/integrations/gitBranches';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import { runDeterministicChecks, buildPrePrPrompt } from '../src/dev/prePrChecks';

function withMocks(opts: { files: string[]; insertions: number; deletions: number; diff: string; commitsBehind: number }) {
  const statSpy = mock.method(gitBranchesModule, 'getBranchDiffStat', async () => ({ files: opts.files, insertions: opts.insertions, deletions: opts.deletions }));
  const diffSpy = mock.method(gitBranchesModule, 'getBranchDiff', async () => opts.diff);
  const gitSpy = mock.method(claudeCodeCliModule, 'git', async (args: string[]) => {
    if (args[0] === 'rev-list') return `${opts.commitsBehind}\n`;
    return '';
  });
  return () => {
    statSpy.mock.restore();
    diffSpy.mock.restore();
    gitSpy.mock.restore();
  };
}

test.afterEach(() => updateSettings({ prePrMaxChangedFiles: '', prePrMaxChangedLines: '' }));

test('runDeterministicChecks: passes everything on a small, clean, up-to-date branch', async () => {
  const restore = withMocks({ files: ['src/foo.ts', 'tests/foo.test.ts'], insertions: 10, deletions: 2, diff: '+++ b/src/foo.ts\n+const x = 1;\n', commitsBehind: 2 });
  try {
    const results = await runDeterministicChecks('C:\\worktree', 'main');
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId.pr_size.status, 'pass');
    assert.equal(byId.debug_leftovers.status, 'pass');
    assert.equal(byId.tests.status, 'pass');
    assert.equal(byId.trunk_drift.status, 'pass');
    assert.equal(byId.build.status, 'skipped');
  } finally {
    restore();
  }
});

test('runDeterministicChecks: pr_size warns above the configured file/line thresholds', async () => {
  updateSettings({ prePrMaxChangedFiles: '2', prePrMaxChangedLines: '10' });
  const restore = withMocks({ files: ['a.ts', 'b.ts', 'c.ts'], insertions: 50, deletions: 10, diff: '', commitsBehind: 0 });
  try {
    const results = await runDeterministicChecks('C:\\worktree', 'main');
    const check = results.find((r) => r.id === 'pr_size')!;
    assert.equal(check.status, 'warn');
    assert.ok(check.evidence.length > 0);
  } finally {
    restore();
  }
});

test('runDeterministicChecks: debug_leftovers flags a console.log added in this branch, but not one already present before it', async () => {
  const diff = ['+++ b/src/foo.ts', '+console.log("debug");', '-console.log("old, already there");', ' unchanged line'].join('\n');
  const restore = withMocks({ files: ['src/foo.ts'], insertions: 1, deletions: 1, diff, commitsBehind: 0 });
  try {
    const results = await runDeterministicChecks('C:\\worktree', 'main');
    const check = results.find((r) => r.id === 'debug_leftovers')!;
    assert.equal(check.status, 'warn');
    assert.equal(check.evidence.length, 1);
    assert.match(check.evidence[0], /console\.log/);
  } finally {
    restore();
  }
});

test('runDeterministicChecks: tests check warns when a changed source file has no matching changed test file', async () => {
  const restore = withMocks({ files: ['src/foo.ts'], insertions: 5, deletions: 0, diff: '', commitsBehind: 0 });
  try {
    const results = await runDeterministicChecks('C:\\worktree', 'main');
    const check = results.find((r) => r.id === 'tests')!;
    assert.equal(check.status, 'warn');
    assert.ok(check.evidence.includes('src/foo.ts'));
  } finally {
    restore();
  }
});

test('runDeterministicChecks: tests check passes when a matching test file was also changed', async () => {
  const restore = withMocks({ files: ['src/foo.ts', 'tests/foo.test.ts'], insertions: 5, deletions: 0, diff: '', commitsBehind: 0 });
  try {
    const results = await runDeterministicChecks('C:\\worktree', 'main');
    assert.equal(results.find((r) => r.id === 'tests')!.status, 'pass');
  } finally {
    restore();
  }
});

test('runDeterministicChecks: trunk_drift warns past the threshold', async () => {
  const restore = withMocks({ files: [], insertions: 0, deletions: 0, diff: '', commitsBehind: 25 });
  try {
    const results = await runDeterministicChecks('C:\\worktree', 'main');
    const check = results.find((r) => r.id === 'trunk_drift')!;
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /25/);
  } finally {
    restore();
  }
});

test('buildPrePrPrompt: embeds ticket summary and deterministic findings as facts', () => {
  const prompt = buildPrePrPrompt({
    ticketSummary: 'Add OAuth refresh',
    ticketDescription: 'Refresh tokens before they expire.',
    deterministic: [{ id: 'pr_size', status: 'warn', title: 'This PR may be large enough to split', detail: '30 files changed', evidence: [] }],
  });
  assert.match(prompt, /Add OAuth refresh/);
  assert.match(prompt, /Refresh tokens before they expire\./);
  assert.match(prompt, /This PR may be large enough to split \[warn\]: 30 files changed/);
  assert.match(prompt, /Do not write any code/);
});

test('buildPrePrPrompt: asks the agent to judge Confluence documentation relevance', () => {
  const prompt = buildPrePrPrompt({ ticketSummary: 'x', ticketDescription: '', deterministic: [] });
  assert.match(prompt, /Confluence page should document it/);
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeCodeCliModule from '../src/integrations/claudeCodeCli';
import { createTicketBranchWorktree } from '../src/integrations/gitBranches';

/** Records every git invocation and answers from `responses` (matched on the joined args), failing closed on anything unexpected. */
function mockGit(responses: Record<string, string | Error>) {
  const calls: string[] = [];
  const spy = mock.method(claudeCodeCliModule, 'git', async (args: string[]) => {
    const key = args.join(' ');
    calls.push(key);
    const match = Object.keys(responses).find((k) => key.startsWith(k));
    if (!match) throw new Error(`unexpected git call: ${key}`);
    const response = responses[match];
    if (response instanceof Error) throw response;
    return response;
  });
  return { calls, spy };
}

test.afterEach(() => mock.restoreAll());

test('createTicketBranchWorktree: a new ticket branch is created off origin/<base> in a fresh worktree', async () => {
  const { calls } = mockGit({ 'fetch origin master': '', 'ls-remote --heads origin feature/X': '', 'branch --list feature/X': '', 'worktree add -b feature/X': '' });
  const result = await createTicketBranchWorktree('C:\\repo', 'feature/X', 'master');
  assert.equal(result.reusedExisting, false);
  assert.match(result.worktreePath, /speako-dev-cycle-feature-X-\d+$/);
  const add = calls.find((c) => c.startsWith('worktree add'))!;
  assert.match(add, /^worktree add -b feature\/X .* origin\/master$/);
});

test('createTicketBranchWorktree: a branch that already exists on origin is fetched and reused, not recreated from trunk', async () => {
  const { calls } = mockGit({
    'fetch origin master': '',
    'ls-remote --heads origin feature/X': 'abc123\trefs/heads/feature/X\n',
    'branch --list feature/X': '',
    'fetch origin feature/X': '',
    'worktree add -b feature/X': '',
  });
  const result = await createTicketBranchWorktree('C:\\repo', 'feature/X', 'master');
  assert.equal(result.reusedExisting, true);
  assert.ok(calls.includes('fetch origin feature/X'));
  const add = calls.find((c) => c.startsWith('worktree add'))!;
  assert.match(add, /origin\/feature\/X$/, 'tracks the remote branch, not origin/master');
});

test('createTicketBranchWorktree: an existing local branch is checked out into the worktree as-is', async () => {
  const { calls } = mockGit({ 'fetch origin master': '', 'ls-remote --heads origin feature/X': '', 'branch --list feature/X': '  feature/X\n', 'worktree add ': '' });
  const result = await createTicketBranchWorktree('C:\\repo', 'feature/X', 'master');
  assert.equal(result.reusedExisting, true);
  const add = calls.find((c) => c.startsWith('worktree add'))!;
  assert.doesNotMatch(add, /-b/, 'no -b: the branch already exists');
  assert.match(add, / feature\/X$/);
});

test("createTicketBranchWorktree: a branch checked out in the developer's own repo is reported as such, not as a raw git error", async () => {
  mockGit({
    'fetch origin master': '',
    'ls-remote --heads origin feature/X': 'abc\trefs/heads/feature/X\n',
    'branch --list feature/X': '* feature/X\n',
    'fetch origin feature/X': '',
    'worktree add ': new Error("Command failed: git worktree add ...\nfatal: 'feature/X' is already used by worktree at 'C:/Users/me/git/master'"),
  });
  await assert.rejects(createTicketBranchWorktree('C:\\repo', 'feature/X', 'master'), /Branch "feature\/X" is already checked out in C:\/Users\/me\/git\/master — switch that checkout to another branch \(e\.g\. git switch master\) and retry\./);
});

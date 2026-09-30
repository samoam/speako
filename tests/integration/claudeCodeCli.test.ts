import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isClaudeCodeConfigured, startClaudeCodeTask, getTaskInfo, getWorktreeDiff, applyCodeChangeToRepo, discardCodeChangeTask, createWorktreeForBranch, removeWorktree } from '../../src/integrations/claudeCodeCli';

const execFileAsync = promisify(execFile);

async function makeDisposableRepo(): Promise<string> {
  const repoPath = path.join(os.tmpdir(), `speako-claude-cli-test-${Date.now()}`);
  fs.mkdirSync(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'readme.txt'), 'initial\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repoPath });
  return repoPath;
}

/** A bare "origin" plus a real clone of it — createWorktreeForBranch needs an actual origin remote to fetch from, not just a local commit. */
async function makeOriginAndClone(): Promise<{ originPath: string; clonePath: string }> {
  const originPath = path.join(os.tmpdir(), `speako-worktree-origin-${Date.now()}`);
  fs.mkdirSync(originPath, { recursive: true });
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: originPath });

  const seedPath = path.join(os.tmpdir(), `speako-worktree-seed-${Date.now()}`);
  fs.mkdirSync(seedPath, { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: seedPath });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: seedPath });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: seedPath });
  fs.writeFileSync(path.join(seedPath, 'readme.txt'), 'initial\n');
  await execFileAsync('git', ['add', '-A'], { cwd: seedPath });
  await execFileAsync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: seedPath });
  await execFileAsync('git', ['remote', 'add', 'origin', originPath], { cwd: seedPath });
  await execFileAsync('git', ['push', '-q', 'origin', 'main'], { cwd: seedPath });

  await execFileAsync('git', ['checkout', '-q', '-b', 'feature'], { cwd: seedPath });
  fs.writeFileSync(path.join(seedPath, 'feature.txt'), 'feature content\n');
  await execFileAsync('git', ['add', '-A'], { cwd: seedPath });
  await execFileAsync('git', ['commit', '-q', '-m', 'add feature.txt'], { cwd: seedPath });
  await execFileAsync('git', ['push', '-q', 'origin', 'feature'], { cwd: seedPath });
  fs.rmSync(seedPath, { recursive: true, force: true });

  const clonePath = path.join(os.tmpdir(), `speako-worktree-clone-${Date.now()}`);
  await execFileAsync('git', ['clone', '-q', originPath, clonePath]);
  return { originPath, clonePath };
}

async function pollUntilDone(cliSessionId: string, timeoutMs: number): Promise<{ state: string; cwd: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getTaskInfo(cliSessionId);
    if (info && (info.state === 'done' || info.state === 'blocked' || info.state === 'stopped' || info.state === 'failed')) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for Claude Code session ${cliSessionId} to finish`);
}

// This is a real, end-to-end confirmation of the exact safety mechanism this
// feature depends on: file edits happen, but git commit/push are hard-
// blocked. Runs against a disposable temp repo created and destroyed within
// the test — never officercc or any real project. Real API cost/latency —
// gated the same way other integration tests are, but expect this one to
// take noticeably longer (a real agentic task, not a single API call).
test(
  'startClaudeCodeTask: a real background agent edits a file but git commit is hard-blocked',
  { skip: !isClaudeCodeConfigured(), timeout: 180_000 },
  async () => {
    const repoPath = await makeDisposableRepo();
    let worktreePath: string | undefined;
    try {
      const { cliSessionId } = await startClaudeCodeTask(
        "Create a file called hello.txt containing the word hello. Then run git commit to commit this change with message 'add hello file'.",
        repoPath
      );
      assert.equal(typeof cliSessionId, 'string');

      const info = await pollUntilDone(cliSessionId, 170_000);
      worktreePath = info.cwd;
      console.log(`[integration] task ended in state "${info.state}" at ${worktreePath}`);

      assert.ok(fs.existsSync(path.join(worktreePath, 'hello.txt')), 'expected hello.txt to have been created');
      assert.equal(fs.readFileSync(path.join(worktreePath, 'hello.txt'), 'utf-8').trim(), 'hello');

      const { stdout: log } = await execFileAsync('git', ['log', '--oneline'], { cwd: worktreePath });
      assert.equal(log.trim().split('\n').length, 1, 'expected no new commit beyond the initial one — git commit should have been blocked');

      const diff = await getWorktreeDiff(worktreePath);
      assert.match(diff, /hello\.txt/);

      // Now exercise the actual approve path: apply the captured diff to the
      // real repo and commit it there — Speako's own controlled action, the
      // only thing allowed to actually commit.
      await applyCodeChangeToRepo(diff, repoPath, 'Implement: test action item');
      const { stdout: repoLog } = await execFileAsync('git', ['log', '--oneline'], { cwd: repoPath });
      assert.equal(repoLog.trim().split('\n').length, 2, 'expected exactly one new commit after approval');
      assert.ok(fs.existsSync(path.join(repoPath, 'hello.txt')), 'expected hello.txt to exist in the real repo after approval');
    } finally {
      if (worktreePath) {
        await discardCodeChangeTask('', worktreePath, repoPath).catch(() => {}); // best-effort — file changes were already committed/discarded by this point
      }
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
);

// Reproduces the real failure seen against a corrupted officercc clone: `git
// worktree add` aborting with "fatal: unable to read tree" because a tree
// object is missing from the local object store, unrelated to the branch
// itself. Confirms createWorktreeForBranch self-heals via `git fetch
// --refetch` instead of surfacing that error to the user.
test('createWorktreeForBranch: self-heals when the local object store is missing a tree it needs', async () => {
  const { originPath, clonePath } = await makeOriginAndClone();
  let worktreePath: string | undefined;
  try {
    // Populate the tree locally the normal way, then delete its loose object
    // file to simulate the same corruption git fsck found in the real repo.
    await execFileAsync('git', ['fetch', 'origin', 'feature'], { cwd: clonePath });
    const { stdout: treeSha } = await execFileAsync('git', ['rev-parse', 'origin/feature^{tree}'], { cwd: clonePath });
    const sha = treeSha.trim();
    const objectPath = path.join(clonePath, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
    assert.ok(fs.existsSync(objectPath), 'expected the fetched tree to be stored as a loose object');
    fs.rmSync(objectPath);

    worktreePath = await createWorktreeForBranch(clonePath, 'feature');

    assert.ok(fs.existsSync(path.join(worktreePath, 'feature.txt')), 'expected the worktree to contain feature.txt after self-healing');
    assert.equal(fs.readFileSync(path.join(worktreePath, 'feature.txt'), 'utf-8').replace(/\r\n/g, '\n'), 'feature content\n');
  } finally {
    if (worktreePath) {
      await removeWorktree(worktreePath, clonePath).catch(() => {});
    }
    fs.rmSync(originPath, { recursive: true, force: true });
    fs.rmSync(clonePath, { recursive: true, force: true });
  }
});

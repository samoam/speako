import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isClaudeCodeConfigured, startClaudeCodeTask, getTaskInfo, getWorktreeDiff, applyCodeChangeToRepo, discardCodeChangeTask } from '../../src/integrations/claudeCodeCli';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { updateSettings } from '../src/settingsStore';
import { isClaudeCodeConfigured, resolveLocalRepoPath, findLocalRepoForBitbucketRepo } from '../src/integrations/claudeCodeCli';

const execFileAsync = promisify(execFile);

/** A throwaway git repo with a fake "origin" remote, just so findLocalRepoForBitbucketRepo has something real to run `git remote get-url origin` against. */
async function makeFakeRepo(remoteUrl: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speako-fake-repo-'));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
  return dir;
}

test.afterEach(() => updateSettings({ codebaseLocalPaths: '' }));

test('isClaudeCodeConfigured: false when no local codebase is configured', () => {
  // An empty string clears the override and falls through to config.ts's
  // own hardcoded default ('officercc=C:\...'), which is NOT empty — so
  // this deliberately sets a value with no "=" instead, which
  // parseCodebaseLocalPaths (config.ts) filters out entirely, genuinely
  // producing zero entries rather than falling back to that default.
  updateSettings({ codebaseLocalPaths: 'not-a-valid-entry' });
  assert.equal(isClaudeCodeConfigured(), false);
});

test('isClaudeCodeConfigured: true once at least one local codebase is configured', () => {
  updateSettings({ codebaseLocalPaths: 'officercc=C:\\fake\\path' });
  assert.equal(isClaudeCodeConfigured(), true);
});

test('resolveLocalRepoPath: resolves a configured name to its path', () => {
  updateSettings({ codebaseLocalPaths: 'officercc=C:\\fake\\path,other=C:\\fake\\other' });
  assert.equal(resolveLocalRepoPath('officercc'), 'C:\\fake\\path');
  assert.equal(resolveLocalRepoPath('other'), 'C:\\fake\\other');
});

test('resolveLocalRepoPath: throws a clear error for an unknown name', () => {
  updateSettings({ codebaseLocalPaths: 'officercc=C:\\fake\\path' });
  assert.throws(() => resolveLocalRepoPath('nonexistent'), /No local codebase configured named "nonexistent"/);
});

test('findLocalRepoForBitbucketRepo: matches by the configured repo\'s actual git remote, not its arbitrary local name', async () => {
  const repoA = await makeFakeRepo('https://git.example.com/scm/proj/repo-a.git');
  const repoB = await makeFakeRepo('https://git.example.com/scm/proj/repo-b.git');
  try {
    updateSettings({ codebaseLocalPaths: `alpha=${repoA},beta=${repoB}` });
    assert.equal(await findLocalRepoForBitbucketRepo('repo-a'), 'alpha');
    assert.equal(await findLocalRepoForBitbucketRepo('repo-b'), 'beta');
    assert.equal(await findLocalRepoForBitbucketRepo('REPO-A'), 'alpha'); // case-insensitive
    assert.equal(await findLocalRepoForBitbucketRepo('unrelated-repo'), null);
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

test('findLocalRepoForBitbucketRepo: skips (not errors on) a configured path that has no git remote', async () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'speako-not-a-repo-'));
  try {
    updateSettings({ codebaseLocalPaths: `broken=${notARepo}` });
    assert.equal(await findLocalRepoForBitbucketRepo('anything'), null);
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
  }
});

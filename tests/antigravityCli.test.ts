import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAntigravityAgent, isAntigravityCliConfigured } from '../src/integrations/antigravityCli';

// Forces ENOENT by blanking PATH — deterministic
// regardless of whether `agy` happens to be installed on the machine
// running this test, and confirms the documented fallback contract
// (ENOENT -> isError:true with a progress log, never a thrown/rejected
// promise) rather than agy's actual output, which needs a real install
// (and being reachable on PATH) to exercise.
test('runAntigravityAgent: resolves with isError:true (not a rejection) when the agy binary can\'t be found', async () => {
  const messages: string[] = [];
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speako-antigravity-cli-test-'));
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    // LOCALAPPDATA too: resolveAgyBinary() checks agy's default install folder before PATH.
    if (key.toLowerCase() === 'path' || key.toLowerCase() === 'localappdata') {
      originalEnv[key] = process.env[key];
      process.env[key] = '';
    }
  }
  try {
    const result = await runAntigravityAgent('review this PR', scratchDir, { mode: 'plan', onProgress: (m) => messages.push(m) });
    assert.equal(result.isError, true);
    assert.equal(isAntigravityCliConfigured(), false);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

import { execFile } from 'child_process';
import { NO_PUSH_GIT_ENV, LEGACY_NO_PUSH_URL } from '../src/integrations/antigravityCli';

// Real git, real repo: the push block must come from the process environment
// alone (GIT_CONFIG_COUNT et al.), never from a config write — worktrees share
// .git/config, and a written block disabled the developer's own pushes (seen
// live 2026-10-02). Verifies git honours the env and that the repo file is untouched.
test('NO_PUSH_GIT_ENV: git in that environment sees a broken push URL while the repo config stays clean', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'speako-no-push-env-'));
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<string>((resolve, reject) => execFile('git', args, { cwd: repo, env: { ...process.env, ...env } }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()))));
  try {
    await run(['init', '-q']);
    await run(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    assert.equal(await run(['remote', 'get-url', '--push', 'origin'], NO_PUSH_GIT_ENV), LEGACY_NO_PUSH_URL);
    assert.equal(await run(['remote', 'get-url', 'origin'], NO_PUSH_GIT_ENV), 'https://example.invalid/repo.git', 'fetch URL untouched');
    assert.equal(await run(['remote', 'get-url', '--push', 'origin']), 'https://example.invalid/repo.git', 'nothing written to the repo config');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAntigravityAgent, isAntigravityCliConfigured } from '../src/integrations/antigravityCli';

// Same ENOENT-forcing technique as tests/geminiCli.test.ts — deterministic
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settingsStore';
import { isClaudeCodeConfigured, resolveLocalRepoPath } from '../src/integrations/claudeCodeCli';

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

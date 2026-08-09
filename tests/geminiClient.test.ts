import test from 'node:test';
import assert from 'node:assert/strict';
import { getGeminiClient } from '../src/gemini/geminiClient';
import { updateSettings } from '../src/settingsStore';

// GoogleGenAI's constructor just stores config (no network call happens until
// an actual .models.* method is invoked), so these tests exercise the real
// constructor rather than mocking it — identity comparisons alone prove the
// caching/invalidation behavior without ever touching the network.

test('getGeminiClient: returns the same instance across repeated calls (caching)', () => {
  const a = getGeminiClient();
  const b = getGeminiClient();
  assert.equal(a, b);
});

test('getGeminiClient: rebuilds the client after a settings change invalidates the cache', () => {
  const before = getGeminiClient();
  updateSettings({ geminiApiKey: 'a-different-fake-key' });
  const after = getGeminiClient();
  assert.notEqual(before, after);
  updateSettings({ geminiApiKey: '' });
});

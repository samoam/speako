import test from 'node:test';
import assert from 'node:assert/strict';
import { getGeminiClient, cleanGeminiErrorMessage } from '../src/gemini/geminiClient';
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

test('cleanGeminiErrorMessage: extracts the human message from the SDK\'s raw JSON error body', () => {
  const err = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}');
  assert.equal(cleanGeminiErrorMessage(err), 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.');
});

test('cleanGeminiErrorMessage: falls back to the raw message for a plain (non-JSON) error', () => {
  const err = new Error('GEMINI_API_KEY is not configured — see NOTES.md.');
  assert.equal(cleanGeminiErrorMessage(err), 'GEMINI_API_KEY is not configured — see NOTES.md.');
});

test('cleanGeminiErrorMessage: falls back to the raw message for JSON that doesn\'t match the expected shape', () => {
  const err = new Error('{"unrelated":"shape"}');
  assert.equal(cleanGeminiErrorMessage(err), '{"unrelated":"shape"}');
});

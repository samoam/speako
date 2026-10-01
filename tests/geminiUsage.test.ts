import test from 'node:test';
import assert from 'node:assert/strict';
import { recordGeminiUsage, getGeminiUsageTotals } from '../src/storage/geminiUsageRepository';
import { logGeminiUsage } from '../src/gemini/logUsage';
import { recordAiUsage, getAiUsageSince } from '../src/storage/aiUsageRepository';

test('geminiUsageRepository: recordGeminiUsage accumulates into all-time totals for a feature', () => {
  const feature = `test-feature-${Date.now()}`;
  recordGeminiUsage(feature, { promptTokens: 100, outputTokens: 20, thinkingTokens: 5 });
  recordGeminiUsage(feature, { promptTokens: 50, outputTokens: 10, thinkingTokens: 0 });

  const totals = getGeminiUsageTotals();
  const row = totals.find((r) => r.feature === feature);
  assert.ok(row, 'expected a row for the recorded feature');
  assert.equal(row!.callCount, 2);
  assert.equal(row!.promptTokens, 150);
  assert.equal(row!.outputTokens, 30);
  assert.equal(row!.thinkingTokens, 5);
});

test('logGeminiUsage: extracts usageMetadata and records it under the given feature', () => {
  const feature = `test-log-${Date.now()}`;
  logGeminiUsage(feature, {
    usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 8, thoughtsTokenCount: 3, totalTokenCount: 53 },
  });

  const row = getGeminiUsageTotals().find((r) => r.feature === feature);
  assert.ok(row);
  assert.equal(row!.callCount, 1);
  assert.equal(row!.promptTokens, 42);
  assert.equal(row!.outputTokens, 8);
  assert.equal(row!.thinkingTokens, 3);
});

test('logGeminiUsage: does nothing (does not throw) when the response has no usageMetadata', () => {
  assert.doesNotThrow(() => logGeminiUsage('test-no-usage', {}));
  assert.doesNotThrow(() => logGeminiUsage('test-no-usage', null));
});

test('getAiUsageSince: merges ai_usage providers with gemini_usage, counting Gemini thinking tokens as output', () => {
  const feature = `test-merged-${Date.now()}`;
  recordAiUsage('claude', feature, 1000, 200);
  recordAiUsage('claude', feature, 500, 100);
  recordAiUsage('jev', feature, 300, 10);
  recordGeminiUsage(feature, { promptTokens: 80, outputTokens: 20, thinkingTokens: 5 });

  const rows = getAiUsageSince(new Date().toISOString().slice(0, 10)).filter((r) => r.feature === feature);
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.deepEqual(
    { calls: byProvider.claude.calls, inputTokens: byProvider.claude.inputTokens, outputTokens: byProvider.claude.outputTokens },
    { calls: 2, inputTokens: 1500, outputTokens: 300 }
  );
  assert.equal(byProvider.jev.calls, 1);
  assert.deepEqual({ calls: byProvider.gemini.calls, outputTokens: byProvider.gemini.outputTokens }, { calls: 1, outputTokens: 25 });
});

test('getAiUsageSince: excludes days before the cutoff', () => {
  const feature = `test-cutoff-${Date.now()}`;
  recordAiUsage('claude', feature, 10, 1);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(getAiUsageSince(tomorrow).filter((r) => r.feature === feature).length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordGeminiUsage, getGeminiUsageTotals } from '../src/storage/geminiUsageRepository';
import { logGeminiUsage } from '../src/gemini/logUsage';

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

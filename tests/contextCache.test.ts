import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedCache } from '../src/gemini/contextCache';
import * as geminiClientModule from '../src/gemini/geminiClient';

test('createSharedCache: returns null without calling Gemini when content is below the cacheable threshold', async () => {
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    caches: { create: async () => { throw new Error('should not be called'); } },
  }));
  try {
    const result = await createSharedCache('gemini-2.5-flash', 'short content');
    assert.equal(result, null);
  } finally {
    spy.mock.restore();
  }
});

test('createSharedCache: creates a cache and returns its name for long-enough content', async () => {
  const longContent = 'x'.repeat(5000);
  let receivedConfig: any;
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    caches: {
      create: async (params: any) => {
        receivedConfig = params;
        return { name: 'cachedContents/abc123' };
      },
    },
  }));
  try {
    const result = await createSharedCache('gemini-2.5-flash', longContent, 300);
    assert.equal(result, 'cachedContents/abc123');
    assert.equal(receivedConfig.model, 'gemini-2.5-flash');
    assert.equal(receivedConfig.config.contents, longContent);
    assert.equal(receivedConfig.config.ttl, '300s');
  } finally {
    spy.mock.restore();
  }
});

test('createSharedCache: falls back to null (does not throw) when cache creation fails', async () => {
  const longContent = 'x'.repeat(5000);
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    caches: {
      create: async () => {
        throw new Error('cache service unavailable');
      },
    },
  }));
  try {
    const result = await createSharedCache('gemini-2.5-flash', longContent);
    assert.equal(result, null);
  } finally {
    spy.mock.restore();
  }
});

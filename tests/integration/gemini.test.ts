import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config';
import { embedText } from '../../src/rag/rag';
import { getGeminiClient } from '../../src/gemini/geminiClient';

test('embedText: returns a real, non-trivial embedding vector', { skip: !config.geminiApiKey, timeout: 30_000 }, async () => {
  const vector = await embedText('This is a test sentence for embedding.');
  assert.ok(Array.isArray(vector));
  assert.ok(vector.length > 0, 'expected a non-empty embedding vector');
  for (const value of vector) {
    assert.equal(typeof value, 'number');
  }
});

test('getGeminiClient: a real generateContent call returns real text', { skip: !config.geminiApiKey, timeout: 30_000 }, async () => {
  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: 'Reply with exactly the single word: pong',
  });
  assert.equal(typeof response.text, 'string');
  assert.ok(response.text!.trim().length > 0);
  console.log(`[integration] Gemini responded: ${response.text!.trim()}`);
});

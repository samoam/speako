import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { extractActionItems } from '../src/summarization/summarize';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { TranscriptSegment } from '../src/types';

function seg(text: string): TranscriptSegment {
  return { sessionId: 's', speaker: 'You', startMs: 0, endMs: 1000, text, isFinal: true };
}

function mockGemini(fake: unknown) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
}

test('extractActionItems: passes through a valid model-classified type', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({
    actionItems: [{ description: 'Fix the bug', confidence: 'explicit', type: 'code_change' }],
  });
  try {
    const items = await extractActionItems([seg('hello')]);
    assert.equal(items[0].type, 'code_change');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('extractActionItems: coerces a missing/invalid type to "general" defensively', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({
    actionItems: [
      { description: 'No type field', confidence: 'inferred' },
      { description: 'Bogus type', confidence: 'inferred', type: 'not-a-real-type' },
    ],
  });
  try {
    const items = await extractActionItems([seg('hello')]);
    assert.equal(items[0].type, 'general');
    assert.equal(items[1].type, 'general');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { anticipateQA } from '../src/prep/anticipateQA';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';

test('anticipateQA: returns null when there are no sources and no user notes', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  try {
    const result = await anticipateQA('generic', 'Some Session', [], undefined);
    assert.equal(result, null);
  } finally {
    updateSettings({ geminiApiKey: '' });
  }
});

test('anticipateQA: returns null when Gemini is not configured, even with sources', async () => {
  const result = await anticipateQA('generic', 'Some Session', [{ name: 'jira_x', content: 'ticket info' }], undefined);
  assert.equal(result, null);
});

test('anticipateQA: parses likelyQuestions/questionsToAsk from a successful call', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const fake = {
    likelyQuestions: [{ question: 'Q1?', suggestedAnswer: 'A1', basedOn: 'TICKET-1' }],
    questionsToAsk: [{ question: 'Q2?', why: 'because' }],
  };
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
  try {
    const result = await anticipateQA('design_dev', 'Design Review', [{ name: 'jira_x', content: 'ticket info' }], undefined);
    assert.deepEqual(result, fake);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('anticipateQA: returns null (not throw) when Gemini call fails', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async () => {
        throw new Error('boom');
      },
    },
  }));
  try {
    const result = await anticipateQA('generic', 'Session', [{ name: 'a', content: 'b' }], undefined);
    assert.equal(result, null);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('anticipateQA: user notes alone (no sources) are enough to proceed', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const fake = { likelyQuestions: [], questionsToAsk: [] };
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
  try {
    const result = await anticipateQA('generic', undefined, [], 'notes about the topic');
    assert.deepEqual(result, fake);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

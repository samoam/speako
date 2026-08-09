import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversation } from '../src/coaching/analyzeConversation';
import { createSession, insertFinalSegment } from '../src/storage/segmentRepository';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';

function seg(sessionId: string, speaker: string, startMs: number, endMs: number, text: string) {
  insertFinalSegment({ sessionId, speaker, startMs, endMs, text, isFinal: true });
}

test('analyzeConversation: returns null when there are no "You" segments', async () => {
  createSession('ac-none', ['en-US'], 'No You', { sessionType: 'personal' });
  seg('ac-none', 'Others', 0, 1000, 'Just them talking.');
  const result = await analyzeConversation('ac-none');
  assert.equal(result, null);
});

test('analyzeConversation: computes talk-time ratio and filler-word count deterministically (no Gemini key)', async () => {
  createSession('ac-metrics', ['en-US'], 'Metrics', { sessionType: 'personal' });
  seg('ac-metrics', 'You', 0, 3000, 'So, um, this is like, you know, a test.'); // 3s, 2 fillers ("um" + "like" + "you know" = 3 actually)
  seg('ac-metrics', 'Others', 3000, 7000, 'Their reply with no fillers at all.'); // 4s

  const result = await analyzeConversation('ac-metrics');
  assert.ok(result);
  // You spoke 3000ms out of a 7000ms total.
  assert.ok(Math.abs(result!.talkTimeRatio - 3000 / 7000) < 1e-9);
  assert.ok(result!.fillerWordCount >= 2, 'expected at least "um" and "like"/"you know" to be counted');
  assert.deepEqual(result!.feedbackPoints, []); // no Gemini key configured in the test environment
});

test('analyzeConversation: fails soft when Gemini is configured but the call throws', async () => {
  createSession('ac-fail', ['en-US'], 'Fail', { sessionType: 'personal' });
  seg('ac-fail', 'You', 0, 1000, 'A perfectly normal sentence.');

  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async () => {
        throw new Error('simulated Gemini outage');
      },
    },
  }));
  try {
    const result = await analyzeConversation('ac-fail');
    assert.ok(result);
    assert.deepEqual(result!.feedbackPoints, []);
    assert.equal(result!.talkTimeRatio, 1);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('analyzeConversation: parses feedbackPoints from a successful Gemini response', async () => {
  createSession('ac-success', ['en-US'], 'Success', { sessionType: 'personal' });
  seg('ac-success', 'You', 0, 1000, 'A perfectly normal sentence.');

  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const fakeFeedback = [{ category: 'clarity', observation: 'obs', quote: null, suggestion: 'sugg' }];
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async () => ({ text: JSON.stringify({ feedbackPoints: fakeFeedback }) }),
    },
  }));
  try {
    const result = await analyzeConversation('ac-success');
    assert.deepEqual(result!.feedbackPoints, fakeFeedback);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

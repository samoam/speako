import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { answerAcrossAllMeetings } from '../src/qa/crossSessionQa';
import { updateSettings } from '../src/settingsStore';
import * as ragModule from '../src/rag/rag';
import * as geminiClientModule from '../src/gemini/geminiClient';

test('answerAcrossAllMeetings: calls retrieve() with no excludeSessionId (cross-session, not scoped to one)', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  let receivedArgs: any[] = [];
  const retrieveSpy = mock.method(ragModule, 'retrieve', async (...args: any[]) => {
    receivedArgs = args;
    return { chunks: [], suppressed: true };
  });
  const clientSpy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: 'answer text' }) },
  }));
  try {
    await answerAcrossAllMeetings('what did we decide about the migration?');
    assert.equal(receivedArgs.length, 1, 'expected retrieve() to be called with only the question, no session id');
  } finally {
    retrieveSpy.mock.restore();
    clientSpy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('answerAcrossAllMeetings: returns deduped session names as sourcesUsed', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({
    chunks: [
      { sessionName: 'Standup Jan 5', text: 'a' },
      { sessionName: 'Standup Jan 5', text: 'b' },
      { sessionName: 'Retro Jan 6', text: 'c' },
    ],
    suppressed: false,
  }));
  const clientSpy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: 'the answer' }) },
  }));
  try {
    const result = await answerAcrossAllMeetings('question');
    assert.equal(result.answerText, 'the answer');
    assert.deepEqual(result.sourcesUsed, ['Standup Jan 5', 'Retro Jan 6']);
  } finally {
    retrieveSpy.mock.restore();
    clientSpy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('answerAcrossAllMeetings: returns no sources when retrieval is suppressed', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  const clientSpy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: 'I don\'t have enough information.' }) },
  }));
  try {
    const result = await answerAcrossAllMeetings('question with no matches');
    assert.deepEqual(result.sourcesUsed, []);
  } finally {
    retrieveSpy.mock.restore();
    clientSpy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

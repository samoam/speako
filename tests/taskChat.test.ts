import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask, getOpenTasks } from '../src/storage/taskRepository';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import * as replyContextGatheringModule from '../src/drafts/kinds/replyContextGathering';
import { answerTaskChatQuestion } from '../src/qa/taskChat';

function seedTask(externalRef: string) {
  upsertTask({ source: 'jira', externalRef, title: 'ETICK-1: Fix the thing', description: 'Needs investigation.', urgencyScore: 3, importanceScore: 3 });
  return getOpenTasks().find((t) => t.source === 'jira' && t.externalRef === externalRef)!;
}

function mockGemini(fakeText: string) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: fakeText }) },
  }));
}

test('answerTaskChatQuestion: throws when Gemini is not configured (test env has no GEMINI_API_KEY)', async () => {
  const task = seedTask('task-chat-test/ETICK-1');
  await assert.rejects(() => answerTaskChatQuestion(task, 'What is this about?', []), /GEMINI_API_KEY/);
});

test('answerTaskChatQuestion: gathers context with the question as the query, and returns the trimmed model response', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const gatherSpy = mock.method(replyContextGatheringModule, 'gatherReplyContext', async () => 'fake gathered context');
  const geminiSpy = mockGemini('  The ticket is currently in progress.  ');
  try {
    const task = seedTask('task-chat-test/ETICK-2');
    const answer = await answerTaskChatQuestion(task, 'What is the status?', []);
    assert.equal(answer, 'The ticket is currently in progress.');
    assert.equal(gatherSpy.mock.calls.length, 1);
    const [, , opts] = gatherSpy.mock.calls[0].arguments;
    assert.equal(opts?.queryOverride, 'What is the status?');
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherSpy.mock.restore();
    geminiSpy.mock.restore();
  }
});

test('answerTaskChatQuestion: falls back to a generic line when the model returns empty text', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const gatherSpy = mock.method(replyContextGatheringModule, 'gatherReplyContext', async () => '');
  const geminiSpy = mockGemini('');
  try {
    const task = seedTask('task-chat-test/ETICK-3');
    const answer = await answerTaskChatQuestion(task, 'Anything new?', []);
    assert.equal(answer, "I don't have anything more specific to add.");
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherSpy.mock.restore();
    geminiSpy.mock.restore();
  }
});

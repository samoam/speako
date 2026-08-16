import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask } from '../src/storage/taskRepository';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { buildMorningBriefing } from '../src/summarization/morningBriefing';

test.afterEach(() => updateSettings({ geminiApiKey: '' }));

test('buildMorningBriefing: reports nothing new when there are no tasks created today', async () => {
  const briefing = await buildMorningBriefing();
  assert.match(briefing, /Nothing new/);
});

test('buildMorningBriefing: without Gemini configured, falls back to a plain count-by-source summary', async () => {
  upsertTask({ source: 'jira', externalRef: `MORN-${Date.now()}`, title: 'Fix the thing', urgencyScore: 3, importanceScore: 3 });
  const briefing = await buildMorningBriefing();
  assert.match(briefing, /1 new Jira ticket/);
});

test('buildMorningBriefing: with Gemini configured, uses the generated digest text', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  upsertTask({ source: 'bitbucket_pr', externalRef: `PROJ/repo#${Date.now()}`, title: 'Review this PR', urgencyScore: 5, importanceScore: 4 });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify({ briefing: 'You have 1 urgent PR review waiting.' }) }) },
  }));
  try {
    const briefing = await buildMorningBriefing();
    assert.equal(briefing, 'You have 1 urgent PR review waiting.');
  } finally {
    spy.mock.restore();
  }
});

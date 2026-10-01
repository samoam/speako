import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateJson, generateText, toJsonSchema } from '../src/ai/aiRouter';
import * as claudeTextModule from '../src/ai/claudeText';
import * as antigravityTextModule from '../src/ai/antigravityText';
import * as geminiClientModule from '../src/gemini/geminiClient';
import * as jevModule from '../src/integrations/typesafeJev';
import { _setConfigOverrides } from '../src/config';
import { classifySegment } from '../src/triggers/classify';
import { checkQuestionsToAskRelevance } from '../src/prep/liveAnticipatedQA';
import { summarizeSession } from '../src/summarization/summarize';

function mockGemini(text: string) {
  const calls: any[] = [];
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async (req: any) => {
        calls.push(req);
        return { text };
      },
    },
  }));
  return { spy, calls };
}

test('toJsonSchema: turns Gemini nullable fields into JSON Schema type unions, recursively', () => {
  const converted = toJsonSchema({
    type: 'object',
    properties: {
      draftReply: { type: 'string', nullable: true },
      items: { type: 'array', items: { type: 'object', properties: { note: { type: 'string', nullable: true } } } },
    },
  });
  assert.deepEqual(converted.properties.draftReply, { type: ['string', 'null'] });
  assert.deepEqual(converted.properties.items.items.properties.note, { type: ['string', 'null'] });
});

test('aiRouter: with Claude routing off, a task goes straight to Gemini fast with the schema attached', async () => {
  const claudeSpy = mock.method(claudeTextModule, 'runClaudeText', async () => {
    throw new Error('should not be called');
  });
  _setConfigOverrides({ geminiApiKey: 'fake-key-for-test' });
  const gemini = mockGemini('{"summary":"hi"}');
  try {
    const result = await generateJson<{ summary: string }>('triageProse', 'test-router-off', 'prompt', { type: 'object' });
    assert.equal(result.summary, 'hi');
    assert.equal(claudeSpy.mock.calls.length, 0);
    assert.equal(gemini.calls.length, 1);
    assert.equal(gemini.calls[0].config.responseMimeType, 'application/json');
  } finally {
    _setConfigOverrides({});
    claudeSpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

test('aiRouter: with Claude routing on, Claude answers first and Gemini is never called', async () => {
  _setConfigOverrides({ claudeTextRouting: 'true' });
  const claudeSpy = mock.method(claudeTextModule, 'runClaudeText', async () => ({ text: 'from claude', structured: null, inputTokens: 1, outputTokens: 1 }));
  const gemini = mockGemini('from gemini');
  try {
    assert.equal(await generateText('liveSuggestion', 'test-router-claude', 'prompt'), 'from claude');
    assert.equal(claudeSpy.mock.calls.length, 1);
    assert.equal((claudeSpy.mock.calls[0].arguments as any[])[1].model, 'haiku');
    assert.equal(gemini.calls.length, 0);
  } finally {
    _setConfigOverrides({});
    claudeSpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

test('aiRouter: a Claude failure falls over to Gemini', async () => {
  _setConfigOverrides({ claudeTextRouting: 'true', geminiApiKey: 'fake-key-for-test' });
  const claudeSpy = mock.method(claudeTextModule, 'runClaudeText', async () => {
    throw new Error('rate limited');
  });
  const gemini = mockGemini('from gemini');
  try {
    assert.equal(await generateText('liveSuggestion', 'test-router-failover', 'prompt'), 'from gemini');
    assert.equal(claudeSpy.mock.calls.length, 1);
    assert.equal(gemini.calls.length, 1);
  } finally {
    _setConfigOverrides({});
    claudeSpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

test('classifySegment: uses Jev when configured, mapping each truth value to present/confidence', async () => {
  const configuredSpy = mock.method(jevModule, 'isJevConfigured', () => true);
  const jevSpy = mock.method(jevModule, 'askJev', async () => ({
    factualClaim: { type: 'noul', noul: 0.91 },
    decisionPoint: { type: 'noul', noul: 0.2 },
    vagueness: { type: 'noul', noul: 0.5 },
  }));
  const gemini = mockGemini('{}');
  try {
    const result = await classifySegment('Revenue grew 12% in Q3.');
    assert.deepEqual(
      { present: result.factualClaim.present, confidence: result.factualClaim.confidence },
      { present: true, confidence: 0.91 }
    );
    assert.equal(result.decisionPoint.present, false);
    assert.equal(result.vagueness.present, true);
    assert.ok(result.factualClaim.reason.length > 0);
    assert.equal(gemini.calls.length, 0);
  } finally {
    configuredSpy.mock.restore();
    jevSpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

test('classifySegment: falls back to Gemini when Jev fails', async () => {
  const configuredSpy = mock.method(jevModule, 'isJevConfigured', () => true);
  const jevSpy = mock.method(jevModule, 'askJev', async () => {
    throw new Error('TypeSafe API 503');
  });
  const fallback = { present: false, confidence: 0.1, reason: 'no' };
  const gemini = mockGemini(JSON.stringify({ factualClaim: fallback, decisionPoint: fallback, vagueness: fallback }));
  try {
    const result = await classifySegment('Hello everyone.');
    assert.equal(gemini.calls.length, 1);
    assert.equal(result.factualClaim.reason, 'no');
  } finally {
    configuredSpy.mock.restore();
    jevSpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

test('checkQuestionsToAskRelevance: with Jev, only questions at or above the conservative bar are returned', async () => {
  const configuredSpy = mock.method(jevModule, 'isJevConfigured', () => true);
  const jevSpy = mock.method(jevModule, 'askJev', async () => ({
    q0: { type: 'noul', noul: 0.92 },
    q1: { type: 'noul', noul: 0.6 },
  }));
  try {
    const result = await checkQuestionsToAskRelevance('We just discussed the release date.', [
      { question: 'When is the release?', why: 'timing' },
      { question: 'Who owns QA?', why: 'ownership' },
    ]);
    assert.deepEqual(result.map((q) => q.question), ['When is the release?']);
  } finally {
    configuredSpy.mock.restore();
    jevSpy.mock.restore();
  }
});

test('summarizeSession: records the model that actually answered (Claude route)', async () => {
  _setConfigOverrides({ claudeTextRouting: 'true' });
  const claudeSpy = mock.method(claudeTextModule, 'runClaudeText', async () => ({
    text: '',
    structured: { overview: 'o', keyDecisions: 'k', discussionTopics: 'd', nextSteps: 'n', topics: ['a'] },
    inputTokens: 1,
    outputTokens: 1,
  }));
  try {
    const summary = await summarizeSession([{ speaker: 'You', text: 'hello', startMs: 0, endMs: 1000 } as any]);
    assert.equal(summary.modelUsed, 'claude-sonnet');
    assert.equal(summary.overview, 'o');
  } finally {
    _setConfigOverrides({});
    claudeSpy.mock.restore();
  }
});

test('aiRouter: with no Gemini key and Claude routing off, it throws without making any network call', async () => {
  const gemini = mockGemini('should not be used');
  try {
    await assert.rejects(() => generateText('chat', 'test-router-none', 'prompt'), /GEMINI_API_KEY/);
    assert.equal(gemini.calls.length, 0);
  } finally {
    gemini.spy.mock.restore();
  }
});

test('aiRouter: when Claude fails, Antigravity answers before Gemini is tried', async () => {
  _setConfigOverrides({ claudeTextRouting: 'true', antigravityTextRouting: 'true', geminiApiKey: 'fake-key-for-test' });
  const claudeSpy = mock.method(claudeTextModule, 'runClaudeText', async () => {
    throw new Error('rate limited');
  });
  const agySpy = mock.method(antigravityTextModule, 'runAntigravityText', async () => ({ text: 'from antigravity', structured: null, inputTokens: 1, outputTokens: 1 }));
  const gemini = mockGemini('from gemini');
  try {
    assert.equal(await generateText('chat', 'test-router-agy', 'prompt'), 'from antigravity');
    assert.equal(claudeSpy.mock.calls.length, 1);
    assert.equal(agySpy.mock.calls.length, 1);
    assert.equal(gemini.calls.length, 0);
  } finally {
    _setConfigOverrides({});
    claudeSpy.mock.restore();
    agySpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

test('aiRouter: web research never goes through Antigravity (unverified web search)', async () => {
  _setConfigOverrides({ claudeTextRouting: 'true', antigravityTextRouting: 'true', geminiApiKey: 'fake-key-for-test' });
  const claudeSpy = mock.method(claudeTextModule, 'runClaudeText', async () => {
    throw new Error('rate limited');
  });
  const agySpy = mock.method(antigravityTextModule, 'runAntigravityText', async () => ({ text: 'from antigravity', structured: null, inputTokens: 1, outputTokens: 1 }));
  const gemini = mockGemini('from gemini');
  try {
    assert.equal(await generateText('webResearch', 'test-router-web', 'prompt', { webSearch: true }), 'from gemini');
    assert.equal(agySpy.mock.calls.length, 0);
    assert.deepEqual(gemini.calls[0].config.tools, [{ googleSearch: {} }]);
  } finally {
    _setConfigOverrides({});
    claudeSpy.mock.restore();
    agySpy.mock.restore();
    gemini.spy.mock.restore();
  }
});

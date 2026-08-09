import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { matchLikelyQuestion, checkQuestionsToAskRelevance } from '../src/prep/liveAnticipatedQA';
import * as ragModule from '../src/rag/rag';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { updateSettings } from '../src/settingsStore';

const likelyQuestion = { question: 'How will you handle backwards compatibility?', suggestedAnswer: 'Nullable fields.', basedOn: 'TICKET-1' };

test('matchLikelyQuestion: returns null immediately with no embedded questions (embedText never called)', async () => {
  const spy = mock.method(ragModule, 'embedText', async () => [1, 0, 0]);
  try {
    const result = await matchLikelyQuestion('any text', []);
    assert.equal(result, null);
    assert.equal(spy.mock.callCount(), 0);
  } finally {
    spy.mock.restore();
  }
});

test('matchLikelyQuestion: matches when the segment embedding is identical to a prepared question', async () => {
  const spy = mock.method(ragModule, 'embedText', async () => [1, 0, 0]);
  try {
    const result = await matchLikelyQuestion(
      'How will you handle backwards compatibility?',
      [{ question: likelyQuestion, embedding: [1, 0, 0] }]
    );
    assert.ok(result);
    assert.equal(result!.item.question.question, likelyQuestion.question);
    assert.ok(result!.score > 0.99);
  } finally {
    spy.mock.restore();
  }
});

test('matchLikelyQuestion: no match for an orthogonal (unrelated) embedding', async () => {
  const spy = mock.method(ragModule, 'embedText', async () => [0, 1, 0]);
  try {
    const result = await matchLikelyQuestion('Completely unrelated small talk.', [{ question: likelyQuestion, embedding: [1, 0, 0] }]);
    assert.equal(result, null);
  } finally {
    spy.mock.restore();
  }
});

test('matchLikelyQuestion: picks the highest-scoring match among multiple candidates', async () => {
  const spy = mock.method(ragModule, 'embedText', async () => [1, 0.05, 0]);
  try {
    const closer = { question: 'closer question', suggestedAnswer: 'a', basedOn: null };
    const farther = { question: 'farther question', suggestedAnswer: 'b', basedOn: null };
    const result = await matchLikelyQuestion('text', [
      { question: farther, embedding: [0.9, 0.4, 0] },
      { question: closer, embedding: [1, 0, 0] },
    ]);
    assert.equal(result!.item.question.question, 'closer question');
  } finally {
    spy.mock.restore();
  }
});

test('checkQuestionsToAskRelevance: returns [] without calling Gemini when there is nothing to check', async () => {
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => {
    throw new Error('should not be called');
  });
  try {
    const result = await checkQuestionsToAskRelevance('summary', []);
    assert.deepEqual(result, []);
  } finally {
    spy.mock.restore();
  }
});

test('checkQuestionsToAskRelevance: filters candidates down to the ones Gemini reports as relevant', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const candidates = [
    { question: 'Are exports affected?', why: 'risk' },
    { question: 'What is the on-call schedule?', why: 'unrelated' },
  ];
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async () => ({ text: JSON.stringify({ relevantQuestions: ['Are exports affected?'] }) }),
    },
  }));
  try {
    const result = await checkQuestionsToAskRelevance('We discussed export pipelines today.', candidates);
    assert.deepEqual(result, [candidates[0]]);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('checkQuestionsToAskRelevance: fails soft (returns []) on a Gemini error', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async () => {
        throw new Error('outage');
      },
    },
  }));
  try {
    const result = await checkQuestionsToAskRelevance('summary', [{ question: 'q', why: 'w' }]);
    assert.deepEqual(result, []);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

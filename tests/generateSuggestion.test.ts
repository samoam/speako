import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateSuggestion } from '../src/suggestions/generate';
import * as codebaseIndexModule from '../src/codebase/indexCodebase';
import * as searchCodeModule from '../src/codebase/searchCode';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { TriggerEvent } from '../src/storage/triggerRepository';

function codeTrigger(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    id: 1,
    sessionId: 'gs-session',
    category: 'code_reference',
    confidence: 0.6,
    reason: 'Mentions code/technical terminology.',
    startMs: 0,
    endMs: 1000,
    segmentText: 'the verifyToken function looks broken',
    ...overrides,
  };
}

function mockGemini(text: string) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text }) },
  }));
}

test('generateSuggestion: code_reference is suppressed outright when local codebase indexing is not configured', async () => {
  const configuredSpy = mock.method(codebaseIndexModule, 'isLocalCodebaseConfigured', () => false);
  const searchSpy = mock.method(searchCodeModule, 'searchCode', async () => []);
  try {
    const result = await generateSuggestion(codeTrigger(), 'the verifyToken function looks broken');
    assert.equal(result, null);
    assert.equal(searchSpy.mock.calls.length, 0); // never even tries to search if nothing is configured
  } finally {
    configuredSpy.mock.restore();
    searchSpy.mock.restore();
  }
});

test('generateSuggestion: code_reference is suppressed when configured but search finds nothing', async () => {
  const configuredSpy = mock.method(codebaseIndexModule, 'isLocalCodebaseConfigured', () => true);
  const searchSpy = mock.method(searchCodeModule, 'searchCode', async () => []);
  try {
    const result = await generateSuggestion(codeTrigger(), 'the verifyToken function looks broken');
    assert.equal(result, null);
  } finally {
    configuredSpy.mock.restore();
    searchSpy.mock.restore();
  }
});

test('generateSuggestion: code_reference builds a citation from repo/file paths, not session names', async () => {
  const configuredSpy = mock.method(codebaseIndexModule, 'isLocalCodebaseConfigured', () => true);
  const searchSpy = mock.method(searchCodeModule, 'searchCode', async () => [
    { repoName: 'speako', filePath: 'src/auth.ts', text: 'export function verifyToken() {...}', score: 0.9 },
  ]);
  const geminiSpy = mockGemini('verifyToken() just checks the token prefix, not a real signature — worth flagging.');
  try {
    const result = await generateSuggestion(codeTrigger(), 'the verifyToken function looks broken');
    assert.ok(result);
    assert.equal(result!.text, 'verifyToken() just checks the token prefix, not a real signature — worth flagging.');
    assert.equal(result!.citation, 'speako/src/auth.ts');
  } finally {
    configuredSpy.mock.restore();
    searchSpy.mock.restore();
    geminiSpy.mock.restore();
  }
});

test('generateSuggestion: code_reference still respects the model saying SKIP', async () => {
  const configuredSpy = mock.method(codebaseIndexModule, 'isLocalCodebaseConfigured', () => true);
  const searchSpy = mock.method(searchCodeModule, 'searchCode', async () => [
    { repoName: 'speako', filePath: 'src/unrelated.ts', text: 'export function unrelatedThing() {}', score: 0.61 },
  ]);
  const geminiSpy = mockGemini('SKIP');
  try {
    const result = await generateSuggestion(codeTrigger(), 'the verifyToken function looks broken');
    assert.equal(result, null);
  } finally {
    configuredSpy.mock.restore();
    searchSpy.mock.restore();
    geminiSpy.mock.restore();
  }
});

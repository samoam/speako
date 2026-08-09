import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  trySource,
  toolSource,
  gatherSources,
  gatherToolSources,
  searchTopic,
  previousSessionNotes,
} from '../src/prep/workflows/types';
import * as toolCatalog from '../src/prep/toolCatalog';
import { createSession, endSession } from '../src/storage/segmentRepository';
import { saveSummaryAndActionItems } from '../src/storage/summaryRepository';

test('trySource: resolves {name, content} on non-empty success', async () => {
  const result = await trySource('my_source', async () => 'hello world');
  assert.deepEqual(result, { name: 'my_source', content: 'hello world' });
});

test('trySource: resolves null on empty/whitespace-only content', async () => {
  assert.equal(await trySource('empty', async () => ''), null);
  assert.equal(await trySource('whitespace', async () => '   '), null);
});

test('trySource: resolves null (not throw) when fn rejects', async () => {
  const errSpy = mock.method(console, 'error', () => {});
  try {
    const result = await trySource('failing', async () => {
      throw new Error('boom');
    });
    assert.equal(result, null);
    assert.ok(errSpy.mock.callCount() >= 1);
  } finally {
    errSpy.mock.restore();
  }
});

test('toolSource: skips the fetch entirely when the tool is inactive', async () => {
  let called = false;
  const fn = async () => {
    called = true;
    return 'content';
  };
  const result = await toolSource({ activeTools: ['jira'] }, 'confluence', 'confluence_x', fn);
  assert.equal(result, null);
  assert.equal(called, false, 'fn should never have been invoked for an inactive tool');
});

test('toolSource: delegates to trySource when the tool is active', async () => {
  const result = await toolSource({ activeTools: ['confluence'] }, 'confluence', 'confluence_x', async () => 'real content');
  assert.deepEqual(result, { name: 'confluence_x', content: 'real content' });
});

test('toolSource: null activeTools treats every tool as active', async () => {
  const result = await toolSource({ activeTools: null }, 'bitbucket', 'bb', async () => 'stuff');
  assert.deepEqual(result, { name: 'bb', content: 'stuff' });
});

test('gatherSources: filters out null results, preserves order of the rest', async () => {
  const { sources } = await gatherSources([
    Promise.resolve({ name: 'a', content: '1' }),
    Promise.resolve(null),
    Promise.resolve({ name: 'b', content: '2' }),
  ]);
  assert.deepEqual(
    sources.map((s) => s.name),
    ['a', 'b']
  );
});

test('gatherToolSources: wires each spec through searchByTool with its query/limit', async () => {
  const calls: any[] = [];
  const spy = mock.method(toolCatalog, 'searchByTool', async (tool: string, query: string, limit: number) => {
    calls.push({ tool, query, limit });
    return `result for ${tool}`;
  });
  try {
    const promises = gatherToolSources(
      { activeTools: null },
      [
        { tool: 'jira', name: 'jira_x', query: 'find tickets', limit: 8 },
        { tool: 'confluence', name: 'confluence_x', query: 'find docs' }, // no limit -> defaults to 5
      ]
    );
    const results = await Promise.all(promises);
    assert.deepEqual(
      results.map((r) => r?.name),
      ['jira_x', 'confluence_x']
    );
    assert.deepEqual(calls, [
      { tool: 'jira', query: 'find tickets', limit: 8 },
      { tool: 'confluence', query: 'find docs', limit: 5 },
    ]);
  } finally {
    spy.mock.restore();
  }
});

test('searchTopic: combines sessionName and userNotes when present', () => {
  assert.equal(searchTopic({ sessionName: 'Design review', userNotes: 'about ETICK-1' }, 'fallback'), 'Design review — about ETICK-1');
});

test('searchTopic: falls back when both sessionName and userNotes are blank', () => {
  assert.equal(searchTopic({ sessionName: undefined, userNotes: '   ' }, 'fallback topic'), 'fallback topic');
});

test('searchTopic: uses whichever of sessionName/userNotes is present', () => {
  assert.equal(searchTopic({ sessionName: 'Just a name', userNotes: undefined }, 'fallback'), 'Just a name');
  assert.equal(searchTopic({ sessionName: undefined, userNotes: 'Just notes' }, 'fallback'), 'Just notes');
});

test('previousSessionNotes: returns empty string when there is no previous session', async () => {
  assert.equal(await previousSessionNotes(undefined), '');
});

test('previousSessionNotes: returns empty string when the previous session has no summary', async () => {
  createSession('wt-no-summary', ['en-US'], 'No Summary', { sessionType: 'work', meetingType: 'generic' });
  endSession('wt-no-summary');
  assert.equal(await previousSessionNotes({ id: 'wt-no-summary', name: 'No Summary' }), '');
});

test('previousSessionNotes: formats overview, decisions, and open action items', async () => {
  createSession('wt-with-summary', ['en-US'], 'With Summary', { sessionType: 'work', meetingType: 'generic' });
  endSession('wt-with-summary');
  saveSummaryAndActionItems(
    'wt-with-summary',
    { overview: 'We discussed X', keyDecisions: 'Decided Y', discussionTopics: 'Topic Z', nextSteps: 'Do W', modelUsed: 'test-model' },
    [{ description: 'Follow up on Y', owner: 'Alice', dueDate: null, confidence: 'explicit' }]
  );
  const notes = await previousSessionNotes({ id: 'wt-with-summary', name: 'With Summary' });
  assert.match(notes, /We discussed X/);
  assert.match(notes, /Decided Y/);
  assert.match(notes, /Follow up on Y \(Alice\)/);
});

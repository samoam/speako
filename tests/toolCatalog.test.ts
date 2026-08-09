import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { searchByTool } from '../src/prep/toolCatalog';
import * as jiraMcp from '../src/integrations/jiraMcp';
import * as confluenceMcp from '../src/integrations/confluenceMcp';
import * as bitbucketServer from '../src/integrations/bitbucketServer';
import * as mem0Client from '../src/integrations/mem0Client';
import * as ragClient from '../src/integrations/ragClient';
import * as searchCodeModule from '../src/codebase/searchCode';
import * as searchExternalMessagesModule from '../src/communications/searchExternalMessages';
import * as webSearchModule from '../src/prep/webSearch';

test('toolCatalog: jira formats path:snippet lines', async () => {
  const spy = mock.method(jiraMcp, 'searchJira', async () => [{ path: 'PROJ-1', snippet: 'first' }, { path: 'PROJ-2', snippet: 'second' }]);
  try {
    const result = await searchByTool('jira', 'query', 5);
    assert.equal(result, 'PROJ-1: first\nPROJ-2: second');
    assert.deepEqual(spy.mock.calls[0].arguments, ['query', 5]);
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: confluence formats path:snippet lines', async () => {
  const spy = mock.method(confluenceMcp, 'searchConfluence', async () => [{ path: 'Design Doc', snippet: 'stuff' }]);
  try {
    const result = await searchByTool('confluence', 'query', 3);
    assert.equal(result, 'Design Doc: stuff');
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: bitbucket formats path:snippet lines', async () => {
  const spy = mock.method(bitbucketServer, 'searchBitbucketServer', async () => [{ path: 'repo/file.ts', snippet: 'code' }]);
  try {
    const result = await searchByTool('bitbucket', 'query', 5);
    assert.equal(result, 'repo/file.ts: code');
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: mem0 joins raw memory strings', async () => {
  const spy = mock.method(mem0Client, 'searchMemory', async () => [{ memory: 'fact one' }, { memory: 'fact two' }]);
  try {
    const result = await searchByTool('mem0', 'query', 5);
    assert.equal(result, 'fact one\nfact two');
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: ragCloud joins raw text', async () => {
  const spy = mock.method(ragClient, 'search', async () => [{ text: 'external ref' }]);
  try {
    const result = await searchByTool('ragCloud', 'query', 5);
    assert.equal(result, 'external ref');
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: localCodebase formats repo/file: text-slice', async () => {
  const spy = mock.method(searchCodeModule, 'searchCode', async () => [
    { repoName: 'speako', filePath: 'src/a.ts', text: 'x'.repeat(400), score: 0.9 },
  ]);
  try {
    const result = await searchByTool('localCodebase', 'query', 5);
    assert.equal(result, `speako/src/a.ts: ${'x'.repeat(300)}`);
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: email passes source="email" to searchExternalMessages', async () => {
  const spy = mock.method(searchExternalMessagesModule, 'searchExternalMessages', async () => [{ text: 'email body' }]);
  try {
    const result = await searchByTool('email', 'query', 5);
    assert.equal(result, 'email body');
    assert.deepEqual(spy.mock.calls[0].arguments, ['query', 'email', 5]);
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: teams passes source="teams" to searchExternalMessages', async () => {
  const spy = mock.method(searchExternalMessagesModule, 'searchExternalMessages', async () => [{ text: 'teams msg' }]);
  try {
    await searchByTool('teams', 'query', 5);
    assert.deepEqual(spy.mock.calls[0].arguments, ['query', 'teams', 5]);
  } finally {
    spy.mock.restore();
  }
});

test('toolCatalog: webSearch ignores the limit argument', async () => {
  const spy = mock.method(webSearchModule, 'prepWebSearch', async (topic: string) => `summary of ${topic}`);
  try {
    const result = await searchByTool('webSearch', 'my topic', 5);
    assert.equal(result, 'summary of my topic');
    assert.equal(spy.mock.calls[0].arguments.length, 1);
  } finally {
    spy.mock.restore();
  }
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as toolCatalog from '../src/prep/toolCatalog';
import * as ragModule from '../src/rag/rag';
import { gatherAudioOverviewContext } from '../src/summarization/audioOverviewContext';

function mockSearchByTool() {
  return mock.method(toolCatalog, 'searchByTool', async (tool: string) => `canned result for ${tool}`);
}

test('gatherAudioOverviewContext: queries every tool key plus past meetings when activeTools is null (all active)', async () => {
  const toolSpy = mockSearchByTool();
  const ragSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  try {
    const context = await gatherAudioOverviewContext('ao-session', 'the roadmap', null);
    const expectedNames = {
      jira: 'jira_context',
      confluence: 'confluence_context',
      bitbucket: 'bitbucket_context',
      ragCloud: 'myrag_context',
      localCodebase: 'local_codebase_context',
      email: 'email_context',
      teams: 'teams_context',
      mem0: 'mem0_context',
    };
    for (const [tool, name] of Object.entries(expectedNames)) {
      assert.ok(context.includes(name), `expected ${name} in context block`);
      assert.ok(context.includes(`canned result for ${tool}`));
    }
    assert.ok(context.includes('web_context'));
  } finally {
    toolSpy.mock.restore();
    ragSpy.mock.restore();
  }
});

test('gatherAudioOverviewContext: respects per-session activeTools gating — only active tools are queried', async () => {
  const toolSpy = mockSearchByTool();
  const ragSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  try {
    const context = await gatherAudioOverviewContext('ao-session', 'the roadmap', ['jira']);
    assert.ok(context.includes('jira_context'));
    for (const name of ['confluence_context', 'bitbucket_context', 'myrag_context', 'local_codebase_context', 'email_context', 'teams_context', 'mem0_context', 'web_context']) {
      assert.ok(!context.includes(name), `did not expect ${name} in context block`);
    }
  } finally {
    toolSpy.mock.restore();
    ragSpy.mock.restore();
  }
});

test('gatherAudioOverviewContext: includes past-meetings RAG results as one more source', async () => {
  const toolSpy = mock.method(toolCatalog, 'searchByTool', async () => '');
  const ragSpy = mock.method(ragModule, 'retrieve', async () => ({
    chunks: [{ sessionName: 'Nova Sync', text: 'we discussed the roadmap' } as any],
    suppressed: false,
  }));
  try {
    const context = await gatherAudioOverviewContext('ao-session', 'the roadmap', []);
    assert.ok(context.includes('past_meetings'));
    assert.ok(context.includes('Nova Sync'));
    assert.ok(context.includes('we discussed the roadmap'));
  } finally {
    toolSpy.mock.restore();
    ragSpy.mock.restore();
  }
});

test('gatherAudioOverviewContext: falls back to a "nothing found" placeholder when every source is empty/inactive', async () => {
  const toolSpy = mock.method(toolCatalog, 'searchByTool', async () => '');
  const ragSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  try {
    const context = await gatherAudioOverviewContext('ao-session', 'the roadmap', []);
    assert.equal(context, '(nothing relevant found across configured tools or past meetings)');
  } finally {
    toolSpy.mock.restore();
    ragSpy.mock.restore();
  }
});

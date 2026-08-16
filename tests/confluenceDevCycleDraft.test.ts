import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle, setDevCycleBranch } from '../src/storage/devCycleRepository';
import { createDraft } from '../src/storage/draftRepository';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import * as jiraMcpModule from '../src/integrations/jiraMcp';
import * as atlassianMcpModule from '../src/integrations/atlassianMcp';
import { confluenceDevCycleDraft } from '../src/drafts/kinds/confluenceDevCycleDraft';

function mockGemini(fake: unknown) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
}

function withFakeAtlassianClient(callToolImpl: (tool: string, args: any) => any) {
  return mock.method(atlassianMcpModule, 'getAtlassianClient', () => ({
    callTool: async (tool: string, args: any) => callToolImpl(tool, args),
  }));
}

function seedCycleWithBranch(ticketKey: string) {
  const cycle = createDevCycle({ ticketKey, repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(cycle.id, { branchName: `feature/${ticketKey}-x`, worktreePath: 'C:\\worktrees\\x' });
  return getDevCycle(cycle.id)!;
}

test.afterEach(() => updateSettings({ geminiApiKey: '', jiraUrl: '', confluenceUrl: '', confluenceUsername: '', confluenceApiToken: '' }));

test('confluenceDevCycleDraft.loadSubject: resolves a real dev cycle by id', async () => {
  const cycle = seedCycleWithBranch('PROJ-1');
  assert.equal((await confluenceDevCycleDraft.loadSubject(String(cycle.id)))?.id, cycle.id);
  assert.equal(await confluenceDevCycleDraft.loadSubject('99999999'), undefined);
});

test('confluenceDevCycleDraft.generate: first generation seeds title/content from the ticket via Gemini and defaults to create mode', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test', jiraUrl: 'https://jira.example.com' });
  const cycle = seedCycleWithBranch('PROJ-2');
  const ticketSpy = mock.method(jiraMcpModule, 'getJiraIssueDetail', async () => ({ key: 'PROJ-2', summary: 'Add caching', description: 'Cache responses.', status: 'In Progress' }));
  const geminiSpy = mockGemini({ title: 'Caching layer added', content: 'We added a caching layer for responses.' });
  try {
    const result = await confluenceDevCycleDraft.generate({ draftId: 1, subject: cycle, history: [] });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.mode, 'create');
    assert.equal((result as any).content.title, 'Caching layer added');
    assert.equal((result as any).content.content, 'We added a caching layer for responses.');
  } finally {
    ticketSpy.mock.restore();
    geminiSpy.mock.restore();
  }
});

test('confluenceDevCycleDraft.generate: a redo (amend strategy) stays in update mode against the same page', async () => {
  const cycle = seedCycleWithBranch('PROJ-3');
  const priorContent = { mode: 'create' as const, spaceKey: 'DEV', parentId: '', pageId: '', title: 'A doc', content: 'Body text' };
  const result = await confluenceDevCycleDraft.generate({
    draftId: 1,
    subject: cycle,
    history: [],
    redo: { priorContent, priorResultRef: { pageId: '123' }, priorHistory: [], observed: '', strategy: 'amend', instruction: 'mention the rollback plan' },
  });
  assert.equal((result as any).content.mode, 'update');
  assert.match((result as any).content.content, /mention the rollback plan/);
});

test('confluenceDevCycleDraft.execute: create mode writes via createConfluencePage', async () => {
  updateSettings({ confluenceUrl: 'https://confluence.example.com', confluenceUsername: 'u', confluenceApiToken: 't' });
  const cycle = seedCycleWithBranch('PROJ-4');
  const spy = withFakeAtlassianClient((tool) => {
    assert.equal(tool, 'confluence_create_page');
    return { content: [{ type: 'text', text: JSON.stringify({ id: '789', _links: { webui: '/pages/789' } }) }] };
  });
  try {
    const result = await confluenceDevCycleDraft.execute('submit', {
      draft: { executionRef: null, resultRef: null } as any,
      subject: cycle,
      content: { mode: 'create', spaceKey: 'DEV', parentId: '', pageId: '', title: 'A doc', content: 'Body' },
    });
    assert.equal((result as any).pageId, '789');
    assert.equal((result as any).action, 'created');
  } finally {
    spy.mock.restore();
  }
});

test('confluenceDevCycleDraft.execute: update mode reuses the pageId from the draft\'s prior result ref', async () => {
  updateSettings({ confluenceUrl: 'https://confluence.example.com', confluenceUsername: 'u', confluenceApiToken: 't' });
  const cycle = seedCycleWithBranch('PROJ-5');
  const draft = createDraft({ kind: 'confluence_dev_cycle_update', subjectKind: 'dev_cycle', subjectId: cycle.id, executionRef: { pageId: '999' } });
  const spy = withFakeAtlassianClient((tool, args) => {
    assert.equal(tool, 'confluence_update_page');
    assert.equal(args.page_id, '999');
    return { content: [{ type: 'text', text: JSON.stringify({}) }] };
  });
  try {
    const result = await confluenceDevCycleDraft.execute('submit', {
      draft,
      subject: cycle,
      content: { mode: 'update', spaceKey: '', parentId: '', pageId: '', title: 'A doc', content: 'Body' },
    });
    assert.equal((result as any).pageId, '999');
    assert.equal((result as any).action, 'updated');
  } finally {
    spy.mock.restore();
  }
});

test('confluenceDevCycleDraft.legacyBroadcast: fires dev-cycle-updated', () => {
  const events = confluenceDevCycleDraft.legacyBroadcast!({ subjectId: '42' } as any, 'completed');
  assert.deepEqual(events, [{ type: 'dev-cycle-updated', devCycleId: 42 }]);
});

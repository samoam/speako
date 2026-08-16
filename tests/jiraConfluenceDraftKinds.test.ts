import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { createSession } from '../src/storage/segmentRepository';
import { insertManualActionItem, getActionItem } from '../src/storage/summaryRepository';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import * as atlassianMcpModule from '../src/integrations/atlassianMcp';
import { jiraActionDraft } from '../src/drafts/kinds/jiraActionDraft';
import { confluencePageDraft } from '../src/drafts/kinds/confluencePageDraft';

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

function seedActionItem(description: string) {
  const sessionId = uuid();
  createSession(sessionId, ['en-US']);
  return insertManualActionItem(sessionId, { description, type: 'jira' });
}

test('jiraActionDraft.loadSubject: resolves a real action item by id', async () => {
  const item = seedActionItem('Do the thing');
  assert.equal((await jiraActionDraft.loadSubject(String(item.id)))?.id, item.id);
  assert.equal(await jiraActionDraft.loadSubject('99999999'), undefined);
});

test('jiraActionDraft.generate: first generation detects an update (issue key present in the description) via the deterministic regex, not the AI', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ issueType: 'Task', summary: 'Move PROJ-42 along', description: 'details', transition: 'In Progress', comment: 'Kicking this off.' });
  try {
    const item = seedActionItem('Update PROJ-42 status to in progress');
    const result = await jiraActionDraft.generate({ draftId: 1, subject: item, history: [] });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.mode, 'update');
    assert.equal((result as any).content.issueKey, 'PROJ-42');
    assert.equal((result as any).content.transition, 'In Progress');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('jiraActionDraft.generate: first generation defaults to create mode when no issue key is present', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ issueType: 'Bug', summary: 'File a bug', description: 'details', transition: null, comment: 'note' });
  try {
    const item = seedActionItem('File a bug about the crash');
    const result = await jiraActionDraft.generate({ draftId: 1, subject: item, history: [] });
    assert.equal((result as any).content.mode, 'create');
    assert.equal((result as any).content.issueKey, '');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('jiraActionDraft.generate: throws when Gemini is not configured (first generation needs a real suggestion call)', async () => {
  const item = seedActionItem('Do the thing');
  await assert.rejects(() => jiraActionDraft.generate({ draftId: 1, subject: item, history: [] }), /GEMINI_API_KEY/);
});

test('jiraActionDraft.generate: a redo carries the prior content forward with a fresh follow-up comment', async () => {
  const item = seedActionItem('Update PROJ-1');
  const priorContent = { mode: 'update' as const, projectKey: '', issueType: '', summary: '', description: '', issueKey: 'PROJ-1', transition: '', comment: 'first comment' };
  const result = await jiraActionDraft.generate({
    draftId: 1,
    subject: item,
    history: [],
    redo: { priorContent, priorResultRef: {}, priorHistory: [], observed: '', strategy: 'follow_up', instruction: 'mention the workaround' },
  });
  assert.equal(result.mode, 'draft');
  assert.equal((result as any).content.issueKey, 'PROJ-1');
  assert.equal((result as any).content.comment, 'mention the workaround');
});

test('jiraActionDraft.execute: update mode requires a transition or a comment', async () => {
  const item = seedActionItem('x');
  await assert.rejects(
    () => jiraActionDraft.execute('submit', { draft: {} as any, subject: item, content: { mode: 'update', projectKey: '', issueType: '', summary: '', description: '', issueKey: 'PROJ-1', transition: '', comment: '' } }),
    /status transition and\/or a comment/
  );
});

test('jiraActionDraft.execute: create mode writes via createJiraIssue and records the action item\'s external_ref', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', jiraPersonalToken: 'tok' });
  const spy = withFakeAtlassianClient((tool) => {
    assert.equal(tool, 'jira_create_issue');
    return { content: [{ type: 'text', text: JSON.stringify({ key: 'PROJ-99' }) }] };
  });
  try {
    const item = seedActionItem('New work');
    const result = await jiraActionDraft.execute('submit', {
      draft: {} as any,
      subject: item,
      content: { mode: 'create', projectKey: 'PROJ', issueType: 'Task', summary: 'New work', description: '', issueKey: '', transition: '', comment: '' },
    });
    assert.equal((result as any).key, 'PROJ-99');
    assert.equal((result as any).action, 'created');
    const updated = getActionItem(item.id)!;
    assert.equal(updated.externalRef?.key, 'PROJ-99');
    assert.equal(updated.externalRef?.tool, 'jira');
  } finally {
    spy.mock.restore();
    updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  }
});

test('jiraActionDraft.legacyBroadcast: fires action-item-updated for the Action Items tab', () => {
  const item = seedActionItem('x');
  const events = jiraActionDraft.legacyBroadcast!({ subjectId: String(item.id) } as any, 'completed');
  assert.equal(events?.length, 1);
  assert.equal((events as any)[0].type, 'action-item-updated');
  assert.equal((events as any)[0].actionItem.id, item.id);
});

test('confluencePageDraft.generate: first generation always defaults to create mode', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ title: 'A doc', content: 'Body text' });
  try {
    const item = seedActionItem('PROJ-1: document the retry logic');
    const result = await confluencePageDraft.generate({ draftId: 1, subject: item, history: [] });
    assert.equal((result as any).content.mode, 'create');
    assert.equal((result as any).content.title, 'A doc');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('confluencePageDraft.generate: a redo (amend strategy) stays in update mode against the same page', async () => {
  const item = seedActionItem('x');
  const priorContent = { mode: 'create' as const, spaceKey: 'DEV', parentId: '', pageId: '', title: 'A doc', content: 'Body text' };
  const result = await confluencePageDraft.generate({
    draftId: 1,
    subject: item,
    history: [],
    redo: { priorContent, priorResultRef: { pageId: '123' }, priorHistory: [], observed: '', strategy: 'amend', instruction: 'add a note about retries' },
  });
  assert.equal((result as any).content.mode, 'update');
  assert.match((result as any).content.content, /add a note about retries/);
});

test('confluencePageDraft.execute: create mode requires a space key', async () => {
  const item = seedActionItem('x');
  await assert.rejects(
    () => confluencePageDraft.execute('submit', { draft: { executionRef: null, resultRef: null } as any, subject: item, content: { mode: 'create', spaceKey: '', parentId: '', pageId: '', title: 't', content: 'c' } }),
    /Space key is required/
  );
});

test('confluencePageDraft.execute: create mode writes via createConfluencePage and records the external_ref', async () => {
  updateSettings({ confluenceUrl: 'https://confluence.example.com', confluenceUsername: 'u', confluenceApiToken: 't' });
  const spy = withFakeAtlassianClient((tool) => {
    assert.equal(tool, 'confluence_create_page');
    return { content: [{ type: 'text', text: JSON.stringify({ id: '456', _links: { webui: '/pages/456' } }) }] };
  });
  try {
    const item = seedActionItem('x');
    const result = await confluencePageDraft.execute('submit', {
      draft: { executionRef: null, resultRef: null } as any,
      subject: item,
      content: { mode: 'create', spaceKey: 'DEV', parentId: '', pageId: '', title: 'A doc', content: 'Body' },
    });
    assert.equal((result as any).pageId, '456');
    const updated = getActionItem(item.id)!;
    assert.equal(updated.externalRef?.key, '456');
    assert.equal(updated.externalRef?.tool, 'confluence');
  } finally {
    spy.mock.restore();
    updateSettings({ confluenceUrl: '', confluenceUsername: '', confluenceApiToken: '' });
  }
});

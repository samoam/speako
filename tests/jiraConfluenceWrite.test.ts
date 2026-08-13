import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraIssue, updateJiraIssue } from '../src/integrations/jiraMcp';
import { createConfluencePage, updateConfluencePage } from '../src/integrations/confluenceMcp';
import * as atlassianMcpModule from '../src/integrations/atlassianMcp';
import { updateSettings } from '../src/settingsStore';

function withFakeClient(callToolImpl: (tool: string, args: any) => any) {
  return mock.method(atlassianMcpModule, 'getAtlassianClient', () => ({
    callTool: async (tool: string, args: any) => callToolImpl(tool, args),
  }));
}

test('createJiraIssue: throws when Jira is not configured', async () => {
  updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  await assert.rejects(
    () => createJiraIssue({ projectKey: 'PROJ', issueType: 'Task', summary: 'x' }),
    /not configured/
  );
});

test('createJiraIssue: calls jira_create_issue with the documented param names and parses the returned key', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', jiraPersonalToken: 'tok' });
  let seenArgs: any;
  const spy = withFakeClient((tool, args) => {
    seenArgs = args;
    assert.equal(tool, 'jira_create_issue');
    return { content: [{ type: 'text', text: JSON.stringify({ key: 'PROJ-42' }) }] };
  });
  try {
    const result = await createJiraIssue({ projectKey: 'PROJ', issueType: 'Task', summary: 'Do the thing', description: 'details' });
    assert.deepEqual(seenArgs, { project_key: 'PROJ', issue_type: 'Task', summary: 'Do the thing', description: 'details' });
    assert.equal(result.key, 'PROJ-42');
    assert.equal(result.url, 'https://jira.example.com/browse/PROJ-42');
  } finally {
    spy.mock.restore();
    updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  }
});

test('createJiraIssue: throws using the tool result text when the server reports an error', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', jiraPersonalToken: 'tok' });
  const spy = withFakeClient(() => ({ isError: true, content: [{ type: 'text', text: 'project does not exist' }] }));
  try {
    await assert.rejects(() => createJiraIssue({ projectKey: 'NOPE', issueType: 'Task', summary: 'x' }), /project does not exist/);
  } finally {
    spy.mock.restore();
    updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  }
});

test('updateJiraIssue: passes transition and comment through to jira_update_issue', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', jiraPersonalToken: 'tok' });
  let seenArgs: any;
  const spy = withFakeClient((tool, args) => {
    seenArgs = args;
    assert.equal(tool, 'jira_update_issue');
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const result = await updateJiraIssue({ issueKey: 'PROJ-1', transition: 'In Progress', comment: 'started' });
    assert.deepEqual(seenArgs, { issue_key: 'PROJ-1', transition: 'In Progress', comment: 'started' });
    assert.equal(result.key, 'PROJ-1');
    assert.equal(result.url, 'https://jira.example.com/browse/PROJ-1');
  } finally {
    spy.mock.restore();
    updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  }
});

test('createConfluencePage: calls confluence_create_page with documented param names and builds a webui URL', async () => {
  updateSettings({ confluenceUrl: 'https://wiki.example.com', confluenceUsername: 'me', confluenceApiToken: 'tok' });
  let seenArgs: any;
  const spy = withFakeClient((tool, args) => {
    seenArgs = args;
    assert.equal(tool, 'confluence_create_page');
    return { content: [{ type: 'text', text: JSON.stringify({ id: '999', _links: { webui: '/spaces/DEV/pages/999' } }) }] };
  });
  try {
    const result = await createConfluencePage({ spaceKey: 'DEV', title: 'A Page', content: 'body', parentId: '111' });
    assert.deepEqual(seenArgs, { space_key: 'DEV', title: 'A Page', content: 'body', parent_id: '111' });
    assert.equal(result.id, '999');
    assert.equal(result.url, 'https://wiki.example.com/spaces/DEV/pages/999');
  } finally {
    spy.mock.restore();
    updateSettings({ confluenceUrl: '', confluenceUsername: '', confluenceApiToken: '' });
  }
});

test('updateConfluencePage: calls confluence_update_page with documented param names', async () => {
  updateSettings({ confluenceUrl: 'https://wiki.example.com', confluenceUsername: 'me', confluenceApiToken: 'tok' });
  let seenArgs: any;
  const spy = withFakeClient((tool, args) => {
    seenArgs = args;
    assert.equal(tool, 'confluence_update_page');
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const result = await updateConfluencePage({ pageId: '999', title: 'New Title', content: 'new body' });
    assert.deepEqual(seenArgs, { page_id: '999', title: 'New Title', content: 'new body' });
    assert.equal(result.id, '999');
  } finally {
    spy.mock.restore();
    updateSettings({ confluenceUrl: '', confluenceUsername: '', confluenceApiToken: '' });
  }
});

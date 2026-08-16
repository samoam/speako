import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIssueKeys, getJiraIssueDetail } from '../src/integrations/jiraMcp';
import { getConfluencePage } from '../src/integrations/confluenceMcp';
import { getPullRequest } from '../src/integrations/bitbucketServer';
import * as atlassianMcpModule from '../src/integrations/atlassianMcp';
import { mock } from 'node:test';
import { updateSettings } from '../src/settingsStore';

function withFakeClient(callToolImpl: (tool: string, args: any) => any) {
  return mock.method(atlassianMcpModule, 'getAtlassianClient', () => ({
    callTool: async (tool: string, args: any) => callToolImpl(tool, args),
  }));
}

test('extractIssueKeys: finds keys embedded in free text, dedupes', () => {
  const keys = extractIssueKeys('Fixes ETICK-1234 and also touches NOVA-9, see ETICK-1234 again');
  assert.deepEqual(keys, ['ETICK-1234', 'NOVA-9']);
});

test('extractIssueKeys: returns an empty array when no key is present', () => {
  assert.deepEqual(extractIssueKeys('just a plain PR title'), []);
});

test('getJiraIssueDetail: throws when Jira is not configured', async () => {
  updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  await assert.rejects(() => getJiraIssueDetail('ETICK-1'), /not configured/);
});

test('getJiraIssueDetail: requests summary/description/status and parses them out', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', jiraPersonalToken: 'tok' });
  let seenArgs: any;
  const spy = withFakeClient((tool, args) => {
    seenArgs = args;
    assert.equal(tool, 'jira_get_issue');
    return {
      content: [{ type: 'text', text: JSON.stringify({ key: 'ETICK-1', fields: { summary: 'Fix the bug', description: 'Detailed repro steps.', status: { name: 'In Progress' } } }) }],
    };
  });
  try {
    const result = await getJiraIssueDetail('ETICK-1');
    assert.deepEqual(seenArgs, { issue_key: 'ETICK-1', fields: 'summary,description,status,issuetype' });
    assert.deepEqual(result, { key: 'ETICK-1', summary: 'Fix the bug', description: 'Detailed repro steps.', status: 'In Progress' });
  } finally {
    spy.mock.restore();
    updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  }
});

test('getJiraIssueDetail: returns null on an error result rather than throwing', async () => {
  updateSettings({ jiraUrl: 'https://jira.example.com', jiraPersonalToken: 'tok' });
  const spy = withFakeClient(() => ({ isError: true, content: [{ type: 'text', text: 'no such issue' }] }));
  try {
    assert.equal(await getJiraIssueDetail('ETICK-999'), null);
  } finally {
    spy.mock.restore();
    updateSettings({ jiraUrl: '', jiraPersonalToken: '' });
  }
});

test('getConfluencePage: throws when Confluence is not configured', async () => {
  updateSettings({ confluenceUrl: '', confluenceUsername: '', confluenceApiToken: '' });
  await assert.rejects(() => getConfluencePage('123'), /not configured/);
});

test('getConfluencePage: calls confluence_get_page with page_id and extracts title/content.value', async () => {
  updateSettings({ confluenceUrl: 'https://wiki.example.com', confluenceUsername: 'me', confluenceApiToken: 'tok' });
  let seenArgs: any;
  const spy = withFakeClient((tool, args) => {
    seenArgs = args;
    assert.equal(tool, 'confluence_get_page');
    return { content: [{ type: 'text', text: JSON.stringify({ metadata: { title: 'Design Doc', content: { value: 'Full page body here.' } } }) }] };
  });
  try {
    const result = await getConfluencePage('285581208');
    assert.deepEqual(seenArgs, { page_id: '285581208' });
    assert.deepEqual(result, { title: 'Design Doc', content: 'Full page body here.' });
  } finally {
    spy.mock.restore();
    updateSettings({ confluenceUrl: '', confluenceUsername: '', confluenceApiToken: '' });
  }
});

test('getPullRequest: throws when Bitbucket is not configured', async () => {
  updateSettings({ bitbucketServerUrl: '', bitbucketServerUsername: '', bitbucketServerToken: '', bitbucketServerRepos: '' });
  await assert.rejects(() => getPullRequest('PROJ', 'repo', 42), /not configured/);
});

test('getPullRequest: maps fromRef/toRef display ids and description', async () => {
  updateSettings({ bitbucketServerUrl: 'https://bitbucket.example.com', bitbucketServerUsername: 'madadi', bitbucketServerToken: 'tok', bitbucketServerRepos: 'PROJ/repo' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: 42,
        title: 'Add caching',
        state: 'OPEN',
        description: 'Implements ETICK-1234.',
        author: { user: { displayName: 'Alice' } },
        links: { self: [{ href: 'https://bitbucket.example.com/PROJ/repo/pr/42' }] },
        fromRef: { displayId: 'feature/caching', repository: { project: { key: 'PROJ' }, slug: 'repo' } },
        toRef: { displayId: 'main', repository: { project: { key: 'PROJ' }, slug: 'repo' } },
        createdDate: 1700000000000,
      })
    )) as any;
  try {
    const pr = await getPullRequest('PROJ', 'repo', 42);
    assert.equal(pr.fromRefDisplayId, 'feature/caching');
    assert.equal(pr.toRefDisplayId, 'main');
    assert.equal(pr.description, 'Implements ETICK-1234.');
  } finally {
    globalThis.fetch = originalFetch;
    updateSettings({ bitbucketServerUrl: '', bitbucketServerUsername: '', bitbucketServerToken: '', bitbucketServerRepos: '' });
  }
});

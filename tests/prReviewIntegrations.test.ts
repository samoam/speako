import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIssueKeys, getJiraIssueDetail } from '../src/integrations/jiraMcp';
import { getConfluencePage } from '../src/integrations/confluenceMcp';
import { getPullRequest, getPullRequestDiff, getPullRequestComments } from '../src/integrations/bitbucketServer';
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

test('getPullRequestDiff: maps diffs/hunks/segments into FileDiff[], preserving line text and change type', async () => {
  updateSettings({ bitbucketServerUrl: 'https://bitbucket.example.com', bitbucketServerUsername: 'madadi', bitbucketServerToken: 'tok', bitbucketServerRepos: 'PROJ/repo' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        diffs: [
          {
            source: { toString: 'src/old.ts' },
            destination: { toString: 'src/old.ts' },
            hunks: [
              {
                sourceLine: 10,
                sourceSpan: 2,
                destinationLine: 10,
                destinationSpan: 3,
                segments: [
                  { type: 'CONTEXT', lines: [{ source: 10, destination: 10, line: 'const x = 1;' }] },
                  { type: 'REMOVED', lines: [{ source: 11, line: 'return x;' }] },
                  {
                    type: 'ADDED',
                    lines: [
                      { destination: 11, line: 'return x + 1;' },
                      { destination: 12, line: 'log(x);' },
                    ],
                  },
                ],
              },
            ],
          },
          {
            source: null,
            destination: { toString: 'src/new.ts' },
            hunks: [],
          },
        ],
      })
    )) as any;
  try {
    const files = await getPullRequestDiff({ id: 42, projectKey: 'PROJ', repoSlug: 'repo' });
    assert.equal(files.length, 2);
    assert.equal(files[0].path, 'src/old.ts');
    assert.equal(files[0].changeType, 'MODIFY');
    assert.equal(files[0].hunks[0].lines.length, 4);
    assert.deepEqual(files[0].hunks[0].lines[1], { text: 'return x;', sourceLine: 11, destinationLine: null, type: 'REMOVED' });
    assert.deepEqual(files[0].hunks[0].lines[2], { text: 'return x + 1;', sourceLine: null, destinationLine: 11, type: 'ADDED' });
    assert.equal(files[1].path, 'src/new.ts');
    assert.equal(files[1].changeType, 'ADD');
  } finally {
    globalThis.fetch = originalFetch;
    updateSettings({ bitbucketServerUrl: '', bitbucketServerUsername: '', bitbucketServerToken: '', bitbucketServerRepos: '' });
  }
});

test('getPullRequestComments: extracts inline anchor info and flattens threaded replies', async () => {
  updateSettings({ bitbucketServerUrl: 'https://bitbucket.example.com', bitbucketServerUsername: 'madadi', bitbucketServerToken: 'tok', bitbucketServerRepos: 'PROJ/repo' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        values: [
          {
            action: 'COMMENTED',
            createdDate: 1700000000000,
            commentAnchor: { path: 'src/foo.ts', line: 12, lineType: 'ADDED', fileType: 'TO' },
            comment: {
              id: 1,
              text: 'Consider renaming this.',
              author: { displayName: 'Bob' },
              createdDate: 1700000000000,
              comments: [{ id: 2, text: 'Good point, done.', author: { displayName: 'Alice' }, createdDate: 1700000001000 }],
            },
          },
          {
            action: 'COMMENTED',
            createdDate: 1700000002000,
            comment: { id: 3, text: 'General comment, no anchor.', author: { name: 'carol' }, createdDate: 1700000002000 },
          },
        ],
        isLastPage: true,
      })
    )) as any;
  try {
    const comments = await getPullRequestComments({ id: 42, title: 'Add caching', projectKey: 'PROJ', repoSlug: 'repo' });
    assert.equal(comments.length, 3);
    assert.deepEqual(comments[0].anchor, { path: 'src/foo.ts', line: 12, lineType: 'ADDED', fileType: 'TO' });
    assert.equal(comments[0].text, 'Consider renaming this.');
    assert.deepEqual(comments[1].anchor, comments[0].anchor);
    assert.equal(comments[1].authorName, 'Alice');
    assert.equal(comments[2].anchor, null);
    assert.equal(comments[2].authorName, 'carol');
  } finally {
    globalThis.fetch = originalFetch;
    updateSettings({ bitbucketServerUrl: '', bitbucketServerUsername: '', bitbucketServerToken: '', bitbucketServerRepos: '' });
  }
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { gatherReviewContext, buildReviewPrompt } from '../src/summarization/prReviewContext';
import * as jiraMcp from '../src/integrations/jiraMcp';
import * as confluenceMcp from '../src/integrations/confluenceMcp';
import { BitbucketPullRequest } from '../src/integrations/bitbucketServer';

function pr(overrides: Partial<BitbucketPullRequest> = {}): BitbucketPullRequest {
  return {
    id: 1,
    title: 'Add caching',
    state: 'OPEN',
    projectKey: 'PROJ',
    repoSlug: 'repo',
    authorName: 'Alice',
    link: 'https://x',
    createdDate: null,
    description: null,
    fromRefDisplayId: 'feature/caching',
    toRefDisplayId: 'main',
    ...overrides,
  };
}

test('gatherReviewContext: skips Jira/Confluence entirely when neither is configured', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => false),
    mock.method(confluenceMcp, 'isConfluenceConfigured', () => false),
  ];
  try {
    const context = await gatherReviewContext(pr({ title: 'Fixes ETICK-1234' }));
    assert.deepEqual(context, { jiraIssues: [], confluencePages: [] });
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('gatherReviewContext: extracts Jira keys from title+description, fetches each, then searches Confluence off the first summary', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getJiraIssueDetail', async (key: string) => ({ key, summary: 'Fix the caching bug', description: 'Details.', status: 'In Progress' })),
    mock.method(confluenceMcp, 'isConfluenceConfigured', () => true),
    mock.method(confluenceMcp, 'searchConfluence', async (query: string) => {
      assert.equal(query, 'Fix the caching bug');
      return [{ path: 'Design Doc', snippet: '', id: '123' }];
    }),
    mock.method(confluenceMcp, 'getConfluencePage', async (id: string) => ({ title: 'Design Doc', content: 'Full body.' })),
  ];
  try {
    const context = await gatherReviewContext(pr({ title: 'Fixes ETICK-1234', description: 'See also NOVA-5' }));
    assert.equal(context.jiraIssues.length, 2);
    assert.deepEqual(context.jiraIssues.map((i) => i.key).sort(), ['ETICK-1234', 'NOVA-5']);
    assert.deepEqual(context.confluencePages, [{ title: 'Design Doc', content: 'Full body.' }]);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('gatherReviewContext: one bad Jira lookup does not block the others', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getJiraIssueDetail', async (key: string) => {
      if (key === 'ETICK-1') throw new Error('boom');
      return { key, summary: 'ok', description: 'ok', status: 'Open' };
    }),
    mock.method(confluenceMcp, 'isConfluenceConfigured', () => false),
  ];
  try {
    const context = await gatherReviewContext(pr({ title: 'ETICK-1 and NOVA-2' }));
    assert.deepEqual(context.jiraIssues.map((i) => i.key), ['NOVA-2']);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('buildReviewPrompt: includes PR title, description, Jira detail, and Confluence content when present', () => {
  const prompt = buildReviewPrompt(pr({ title: 'Add caching', description: 'PR body text' }), {
    jiraIssues: [{ key: 'ETICK-1234', summary: 'Fix caching bug', description: 'Repro steps.', status: 'In Progress' }],
    confluencePages: [{ title: 'Caching Design', content: 'Design details.' }],
  });
  assert.match(prompt, /Add caching/);
  assert.match(prompt, /PR body text/);
  assert.match(prompt, /ETICK-1234/);
  assert.match(prompt, /Repro steps\./);
  assert.match(prompt, /Caching Design/);
  assert.match(prompt, /Design details\./);
});

test('buildReviewPrompt: omits context sections entirely when nothing was found', () => {
  const prompt = buildReviewPrompt(pr({ description: null }), { jiraIssues: [], confluencePages: [] });
  assert.doesNotMatch(prompt, /Linked Jira/);
  assert.doesNotMatch(prompt, /Related documentation/);
});

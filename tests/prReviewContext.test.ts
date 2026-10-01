import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { gatherReviewContext, buildReviewPrompt, mergeReviews } from '../src/summarization/prReviewContext';
import * as jiraMcp from '../src/integrations/jiraMcp';
import * as confluenceMcp from '../src/integrations/confluenceMcp';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { updateSettings } from '../src/settingsStore';
import { BitbucketPullRequest, BitbucketPullRequestComment } from '../src/integrations/bitbucketServer';
import { StructuredReview } from '../src/storage/prReviewRequestRepository';
import { SPEAKO_COMMENT_MARKER } from '../src/summarization/prReviewComments';

function mockGemini(fake: unknown) {
  // The AI router skips its Gemini route entirely without a key, so a mocked client still needs one set.
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const generateContent = mock.fn(async () => ({ text: JSON.stringify(fake) }));
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({ models: { generateContent } }));
  const getGeminiClient = {
    mock: {
      restore: () => {
        spy.mock.restore();
        updateSettings({ geminiApiKey: '' });
      },
    },
  };
  return { getGeminiClient, generateContent };
}

function existingComment(overrides: Partial<BitbucketPullRequestComment> = {}): BitbucketPullRequestComment {
  return {
    prId: 1,
    prTitle: 'Add caching',
    projectKey: 'PROJ',
    repoSlug: 'repo',
    commentId: 1,
    authorName: 'Bob',
    authorUsername: 'bob',
    rootCommentId: 1,
    text: 'Please add a test for the miss case.',
    createdDate: '2026-01-01T00:00:00.000Z',
    anchor: null,
    ...overrides,
  };
}

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

test('buildReviewPrompt: includes PR title, author, description, Jira detail, and Confluence content when present', () => {
  const prompt = buildReviewPrompt(pr({ title: 'Add caching', description: 'PR body text', authorName: 'Alice' }), {
    jiraIssues: [{ key: 'ETICK-1234', summary: 'Fix caching bug', description: 'Repro steps.', status: 'In Progress' }],
    confluencePages: [{ title: 'Caching Design', content: 'Design details.' }],
  });
  assert.match(prompt, /Add caching/);
  assert.match(prompt, /opened by Alice/);
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
  assert.doesNotMatch(prompt, /Comments already on this PR/);
});

test('buildReviewPrompt: lists existing comments and instructs against repeating them, labeling prior Speako comments distinctly', () => {
  const prompt = buildReviewPrompt(
    pr(),
    { jiraIssues: [], confluencePages: [] },
    [
      existingComment({ authorName: 'Bob', text: 'Please add a test for the miss case.' }),
      existingComment({ authorName: 'irrelevant', text: `**major** — Missing null check.\n\n_${SPEAKO_COMMENT_MARKER}; reviewed and posted by a human._` }),
    ]
  );
  assert.match(prompt, /Comments already on this PR/);
  assert.match(prompt, /do not raise a finding that just repeats one of these/);
  assert.match(prompt, /Bob: Please add a test for the miss case\./);
  assert.match(prompt, /Speako \(prior review\): .*Missing null check\./);
});

test('mergeReviews: returns the merged structured output parsed from the Gemini API response', async (t) => {
  const claudeReview: StructuredReview = {
    summary: 'Adds response caching.',
    recommendation: 'comment',
    findings: [{ file: 'src/cache.ts', line: 10, severity: 'minor', comment: 'Consider a TTL.' }],
  };
  const merged: StructuredReview = {
    summary: 'Adds response caching; also missing a test for the miss path.',
    recommendation: 'request_changes',
    findings: [
      { file: 'src/cache.ts', line: 10, severity: 'minor', comment: 'Consider a TTL.' },
      { file: 'src/cache.ts', line: null, severity: 'major', comment: 'No test covers the cache-miss path.' },
    ],
  };
  const { getGeminiClient, generateContent } = mockGemini(merged);
  t.after(() => getGeminiClient.mock.restore());

  const result = await mergeReviews(claudeReview, 'Reviewer B: looks fine but no test for the miss case.');
  assert.deepEqual(result, merged);
  assert.equal(generateContent.mock.calls.length, 1);
  const callArgs = (generateContent.mock.calls[0].arguments as any[])[0];
  assert.match(callArgs.contents, /Reviewer B: looks fine but no test for the miss case\./);
});

test('mergeReviews: falls back to the Claude review\'s own fields for anything missing from the parsed response', async (t) => {
  const claudeReview: StructuredReview = {
    summary: 'Adds response caching.',
    recommendation: 'approve',
    findings: [],
  };
  const { getGeminiClient } = mockGemini({}); // a malformed/empty response shouldn't crash the merge
  t.after(() => getGeminiClient.mock.restore());

  const result = await mergeReviews(claudeReview, 'Reviewer B text.');
  assert.deepEqual(result, claudeReview);
});

test('gatherReviewContext: finds the Jira key in the branch name and fetches it over Jira REST', async (t) => {
  updateSettings({ jiraUrl: 'https://jira.example.com/jira', jiraPersonalToken: 'pat-token' });
  t.after(() => updateSettings({ jiraUrl: '', jiraPersonalToken: '' }));
  const fetchSpy = mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    assert.match(String(url), /\/rest\/api\/2\/issue\/ETICK-10230\?/);
    assert.equal(init.headers.Authorization, 'Bearer pat-token');
    return new Response(JSON.stringify({ key: 'ETICK-10230', fields: { summary: 'SQL injection', description: 'Escape inputs', status: { name: 'In Progress' } } }), { status: 200 });
  });
  t.after(() => fetchSpy.mock.restore());
  // Key only in the branch, after an underscore — the case \b used to miss.
  const pr = { id: 1, title: 'Fix injection', description: null, fromRefDisplayId: 'bugfix_ETICK-10230-sql-injection', toRefDisplayId: 'master', projectKey: 'GTEE', repoSlug: 'officercc', authorName: 'Jacob', link: '', state: 'OPEN', createdDate: null } as any;
  const context = await gatherReviewContext(pr);
  assert.deepEqual(context.jiraIssues.map((i) => [i.key, i.summary, i.status]), [['ETICK-10230', 'SQL injection', 'In Progress']]);
});

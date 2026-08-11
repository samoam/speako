import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { updateSettings } from '../src/settingsStore';
import * as bitbucketServer from '../src/integrations/bitbucketServer';
import { getPullRequestActivity, formatPullRequestActivity } from '../src/integrations/bitbucketReviews';

test.before(() => updateSettings({ bitbucketServerUsername: 'madadi' }));
test.after(() => updateSettings({ bitbucketServerUsername: '' }));

function pr(overrides: Partial<any> = {}) {
  return { id: 1, title: 'Fix bug', state: 'OPEN', projectKey: 'PROJ', repoSlug: 'repo', authorName: 'Alice', link: 'https://x', ...overrides };
}

function comment(overrides: Partial<any> = {}) {
  return { prId: 1, prTitle: 'Fix bug', projectKey: 'PROJ', repoSlug: 'repo', authorName: 'Alice', text: 'looks good', createdDate: '2026-08-11T00:00:00.000Z', ...overrides };
}

test('getPullRequestActivity: separates review requests, comments on my PRs, and mentions', async () => {
  const reviewPr = pr({ id: 2, title: 'Review this', myApprovalStatus: 'UNAPPROVED' });
  const myPr = pr({ id: 1 });

  const rolesSpy = mock.method(bitbucketServer, 'getPullRequestsForRole', async (role: string) =>
    role === 'REVIEWER' ? [reviewPr] : [myPr]
  );
  const commentsSpy = mock.method(bitbucketServer, 'getPullRequestComments', async (target: any) => {
    if (target.id === 1) return [comment({ prId: 1, text: 'looks good' }), comment({ prId: 1, text: 'hey @madadi can you check this?' })];
    if (target.id === 2) return [comment({ prId: 2, prTitle: 'Review this', text: 'no mention here' })];
    return [];
  });

  try {
    const activity = await getPullRequestActivity();
    assert.deepEqual(activity.reviewRequests, [reviewPr]);
    assert.equal(activity.commentsOnMyPRs.length, 1);
    assert.equal(activity.commentsOnMyPRs[0].text, 'looks good');
    assert.equal(activity.mentionsOfMe.length, 1);
    assert.match(activity.mentionsOfMe[0].text, /@madadi/);
    assert.equal(rolesSpy.mock.callCount(), 2);
    assert.equal(commentsSpy.mock.callCount(), 2);
  } finally {
    rolesSpy.mock.restore();
    commentsSpy.mock.restore();
  }
});

test('getPullRequestActivity: one failing comment fetch does not drop the others', async () => {
  const rolesSpy = mock.method(bitbucketServer, 'getPullRequestsForRole', async (role: string) =>
    role === 'REVIEWER' ? [pr({ id: 2 })] : [pr({ id: 1 })]
  );
  const commentsSpy = mock.method(bitbucketServer, 'getPullRequestComments', async (target: any) => {
    if (target.id === 2) throw new Error('boom');
    return [comment({ prId: 1 })];
  });

  try {
    const activity = await getPullRequestActivity();
    assert.equal(activity.commentsOnMyPRs.length, 1);
  } finally {
    rolesSpy.mock.restore();
    commentsSpy.mock.restore();
  }
});

test('formatPullRequestActivity: omits empty sections, includes populated ones', async () => {
  const rolesSpy = mock.method(bitbucketServer, 'getPullRequestsForRole', async (role: string) =>
    role === 'REVIEWER' ? [pr({ id: 2, title: 'Needs review' })] : []
  );
  const commentsSpy = mock.method(bitbucketServer, 'getPullRequestComments', async () => []);

  try {
    const text = await formatPullRequestActivity();
    assert.match(text, /PRs assigned to you for review/);
    assert.match(text, /Needs review/);
    assert.ok(!text.includes('Comments mentioning you'));
    assert.ok(!text.includes('Other comments on your pull requests'));
  } finally {
    rolesSpy.mock.restore();
    commentsSpy.mock.restore();
  }
});

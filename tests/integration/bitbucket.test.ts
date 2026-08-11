import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBitbucketServer, getPullRequestsForRole, isBitbucketConfigured } from '../../src/integrations/bitbucketServer';
import { getPullRequestActivity } from '../../src/integrations/bitbucketReviews';

test(
  'searchBitbucketServer: real call against the configured repo succeeds and returns well-shaped results',
  { skip: !isBitbucketConfigured(), timeout: 30_000 },
  async () => {
    // searchBitbucketServer matches query words (>3 chars) against recent
    // commit messages, not a real search index — real repo activity is
    // unpredictable, so this only asserts structural correctness, not a
    // guaranteed non-empty result.
    const matches = await searchBitbucketServer('update fix change', 10);
    assert.ok(Array.isArray(matches));
    console.log(`[integration] searchBitbucketServer returned ${matches.length} match(es)`);
    for (const m of matches) {
      assert.equal(typeof m.path, 'string');
      assert.equal(typeof m.snippet, 'string');
    }
  }
);

test(
  'getPullRequestsForRole: real dashboard call succeeds and returns well-shaped PRs',
  { skip: !isBitbucketConfigured(), timeout: 30_000 },
  async () => {
    const reviewing = await getPullRequestsForRole('REVIEWER', 'OPEN');
    console.log(`[integration] PRs assigned to me as reviewer: ${reviewing.length}`);
    for (const pr of reviewing) {
      assert.equal(typeof pr.id, 'number');
      assert.equal(typeof pr.title, 'string');
      assert.equal(typeof pr.projectKey, 'string');
      assert.equal(typeof pr.repoSlug, 'string');
    }
  }
);

test(
  'getPullRequestActivity: real end-to-end call succeeds and returns well-shaped activity',
  { skip: !isBitbucketConfigured(), timeout: 60_000 },
  async () => {
    const activity = await getPullRequestActivity();
    console.log(
      `[integration] reviewRequests=${activity.reviewRequests.length} commentsOnMyPRs=${activity.commentsOnMyPRs.length} mentionsOfMe=${activity.mentionsOfMe.length}`
    );
    assert.ok(Array.isArray(activity.reviewRequests));
    assert.ok(Array.isArray(activity.commentsOnMyPRs));
    assert.ok(Array.isArray(activity.mentionsOfMe));
  }
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBitbucketServer, isBitbucketConfigured } from '../../src/integrations/bitbucketServer';

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

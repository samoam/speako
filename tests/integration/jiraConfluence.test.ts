import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { searchJira, isJiraConfigured } from '../../src/integrations/jiraMcp';
import { searchConfluence, isConfluenceConfigured } from '../../src/integrations/confluenceMcp';
import { getAtlassianClient } from '../../src/integrations/atlassianMcp';

// mcp-atlassian's cold start is ~15-20s (documented in NOTES.md) — generous
// per-test timeouts here, not a sign anything is wrong.
const TIMEOUT_MS = 60_000;

test(
  'searchJira: returns real, well-shaped results from the configured Jira instance',
  { skip: !isJiraConfigured(), timeout: TIMEOUT_MS },
  async () => {
    const matches = await searchJira('fix', 10);
    assert.ok(Array.isArray(matches));
    console.log(`[integration] searchJira returned ${matches.length} match(es)`);
    for (const m of matches) {
      assert.equal(typeof m.path, 'string');
      assert.equal(typeof m.snippet, 'string');
      assert.ok(m.path.length > 0);
    }
  }
);

test(
  'searchConfluence: returns real, well-shaped results from the configured Confluence instance',
  { skip: !isConfluenceConfigured(), timeout: TIMEOUT_MS },
  async () => {
    const matches = await searchConfluence('documentation', 10);
    assert.ok(Array.isArray(matches));
    console.log(`[integration] searchConfluence returned ${matches.length} match(es)`);
    for (const m of matches) {
      assert.equal(typeof m.path, 'string');
      assert.equal(typeof m.snippet, 'string');
    }
  }
);

// Closes the shared mcp-atlassian subprocess (src/integrations/atlassianMcp.ts)
// after this file's tests finish — otherwise it lingers as an orphaned
// process, exactly the class of problem NOTES.md documents fighting earlier
// in this project.
after(() => {
  if (isJiraConfigured() || isConfluenceConfigured()) {
    getAtlassianClient().close();
  }
});

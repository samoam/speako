import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { searchMemory, isMem0Configured, closeMem0Client } from '../../src/integrations/mem0Client';
import * as ragClient from '../../src/integrations/ragClient';
import { isRagConfigured, closeRagClient } from '../../src/integrations/ragClient';

// Cloud Run services can be scaled to zero, so a cold start can take a while
// — a slow real response is tolerated via a longer timeout, not treated as a
// failure the way a hard-coded short timeout would.
const COLD_START_TIMEOUT_MS = 45_000;

test(
  'searchMemory: a real query against mem0-cloud returns well-shaped results',
  { skip: !isMem0Configured(), timeout: COLD_START_TIMEOUT_MS },
  async () => {
    const matches = await searchMemory('meeting', 5);
    assert.ok(Array.isArray(matches));
    console.log(`[integration] searchMemory returned ${matches.length} match(es)`);
    for (const m of matches) {
      assert.equal(typeof m.memory, 'string');
    }
  }
);

test(
  'ragClient.search: a real query against rag-cloud (MyRAG) returns well-shaped results',
  { skip: !isRagConfigured(), timeout: COLD_START_TIMEOUT_MS },
  async () => {
    const matches = await ragClient.search('meeting', 5);
    assert.ok(Array.isArray(matches));
    console.log(`[integration] ragClient.search returned ${matches.length} match(es)`);
    for (const m of matches) {
      assert.equal(typeof m.text, 'string');
      assert.equal(typeof m.score, 'number');
    }
  }
);

// Both clients hold an open HTTP MCP connection — fine for the long-running
// app, but without an explicit close, this process's event loop never goes
// idle and node:test hangs waiting for it to exit.
after(() => {
  closeMem0Client();
  closeRagClient();
});

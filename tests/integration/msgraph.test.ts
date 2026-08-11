import test from 'node:test';
import assert from 'node:assert/strict';
import { isMsGraphConfigured } from '../../src/integrations/msGraphAuth';
import { syncOutlookAndTeams } from '../../src/integrations/msGraphSync';

test(
  'syncOutlookAndTeams: real call against the signed-in account succeeds and returns well-shaped counts',
  { skip: !isMsGraphConfigured(), timeout: 30_000 },
  async () => {
    const result = await syncOutlookAndTeams();
    console.log(`[integration] syncOutlookAndTeams: ${result.emailCount} email(s), ${result.chatMessageCount} chat message(s)`);
    assert.equal(typeof result.emailCount, 'number');
    assert.equal(typeof result.chatMessageCount, 'number');
    assert.ok(result.emailCount >= 0);
    assert.ok(result.chatMessageCount >= 0);
  }
);

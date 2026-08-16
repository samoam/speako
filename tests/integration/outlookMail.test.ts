import test from 'node:test';
import assert from 'node:assert/strict';
import { syncOutlookMail } from '../../src/integrations/outlookMailSync';

test(
  'syncOutlookMail: real call via the Microsoft 365 connector succeeds and returns a well-shaped count',
  { timeout: 60_000 },
  async () => {
    const result = await syncOutlookMail();
    console.log(`[integration] syncOutlookMail: ${result.emailCount} email(s)`);
    assert.equal(typeof result.emailCount, 'number');
    assert.ok(result.emailCount >= 0);
  }
);

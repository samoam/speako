import test from 'node:test';
import assert from 'node:assert/strict';
import { listUpcomingMicrosoft365Events } from '../../src/integrations/microsoft365Calendar';

test(
  'listUpcomingMicrosoft365Events: real call via the Microsoft 365 connector succeeds and returns well-shaped events',
  { timeout: 60_000 },
  async () => {
    const events = await listUpcomingMicrosoft365Events(7 * 24 * 60); // wide window so this has something to assert on
    console.log(`[integration] listUpcomingMicrosoft365Events returned ${events.length} event(s) in the next 7 days`);
    for (const e of events) {
      assert.equal(typeof e.id, 'string');
      assert.equal(typeof e.title, 'string');
      assert.equal(typeof e.startTime, 'string');
      assert.equal(typeof e.attendeeCount, 'number');
      assert.equal(typeof e.isRecurring, 'boolean');
    }
  }
);

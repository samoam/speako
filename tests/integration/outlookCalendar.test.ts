import test from 'node:test';
import assert from 'node:assert/strict';
import { isOutlookDesktopConfigured } from '../../src/integrations/outlookDesktop';
import { listUpcomingOutlookEvents } from '../../src/integrations/outlookDesktopCalendar';

test(
  'listUpcomingOutlookEvents: real call against classic Outlook succeeds and returns well-shaped events',
  { skip: !isOutlookDesktopConfigured(), timeout: 30_000 },
  async () => {
    const events = await listUpcomingOutlookEvents(7 * 24 * 60); // wide window so this has something to assert on
    console.log(`[integration] listUpcomingOutlookEvents returned ${events.length} event(s) in the next 7 days`);
    for (const e of events) {
      assert.equal(typeof e.id, 'string');
      assert.equal(typeof e.title, 'string');
      assert.equal(typeof e.startTime, 'string');
      assert.equal(typeof e.attendeeCount, 'number');
      assert.equal(typeof e.isRecurring, 'boolean');
    }
  }
);

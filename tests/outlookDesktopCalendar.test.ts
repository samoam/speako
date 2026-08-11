import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as outlookDesktop from '../src/integrations/outlookDesktop';
import { listUpcomingOutlookEvents } from '../src/integrations/outlookDesktopCalendar';

test('listUpcomingOutlookEvents: returns [] without spawning PowerShell when not configured (non-Windows)', async () => {
  const spy = mock.method(outlookDesktop, 'isOutlookDesktopConfigured', () => false);
  try {
    const events = await listUpcomingOutlookEvents(15);
    assert.deepEqual(events, []);
  } finally {
    spy.mock.restore();
  }
});

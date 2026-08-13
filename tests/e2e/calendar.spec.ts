import { test, expect, Page } from '@playwright/test';
import { createSession } from './fixtures';

/**
 * The real GET /api/calendar/week route shells out to Outlook desktop COM
 * automation (scripts/outlookCalendarExport.ps1) against whatever real
 * calendar exists on this machine — unlike every other e2e spec in this
 * suite, hitting that for real here would make the test's result depend on
 * whatever meetings happen to be in the tester's actual Outlook right now,
 * and risks triggering a real "Object Model Guard" security prompt (see
 * NOTES.md). Routed through page.route() instead, so this spec exercises
 * only Speako's own grid-rendering/click-through logic against fixed,
 * known event data — the first use of network mocking in this e2e suite,
 * deliberately, for that reason.
 */
function mockCalendarWeek(page: Page, events: unknown[]): Promise<void> {
  return page.route('**/api/calendar/week', (route) => route.fulfill({ json: events }));
}

test('calendar view: renders this week\'s events and opens a linked session on click', async ({ page }) => {
  const sessionId = `e2e-cal-${Date.now()}`;
  const sessionName = `e2e-calendar-${Date.now()}`;
  const linkedEventId = `evt-linked-${Date.now()}`;
  createSession(sessionId, ['en-US'], sessionName, { calendarEventId: linkedEventId });

  const now = new Date();
  const linkedStart = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const unlinkedStart = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

  await mockCalendarWeek(page, [
    { id: linkedEventId, title: 'Linked standup', description: '', startTime: linkedStart, attendeeCount: 3, isRecurring: true, sessionId },
    { id: `evt-unlinked-${Date.now()}`, title: 'Not yet imported', description: '', startTime: unlinkedStart, attendeeCount: 2, isRecurring: false, sessionId: null },
  ]);

  await page.goto('/');
  await page.click('#calendarBtn');
  await expect(page.locator('#calendarGrid')).toBeVisible();
  await expect(page.locator('#calendarEmptyState')).toBeHidden();

  const linkedBlock = page.locator('.cal-event-linked', { hasText: 'Linked standup' });
  await expect(linkedBlock).toBeVisible();

  const unlinkedBlock = page.locator('.cal-event', { hasText: 'Not yet imported' });
  await expect(unlinkedBlock).toBeVisible();
  await expect(unlinkedBlock).not.toHaveClass(/cal-event-linked/);

  await linkedBlock.click();
  await expect(page.locator('#calendarOverlay')).toBeHidden();
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);
});

test('calendar view: shows an empty state when there are no events this week', async ({ page }) => {
  await mockCalendarWeek(page, []);

  await page.goto('/');
  await page.click('#calendarBtn');
  await expect(page.locator('#calendarEmptyState')).toBeVisible();
  await expect(page.locator('#calendarGrid')).toBeHidden();
});

// Regression test for a real bug: the sync status used to check once on a
// fixed delay and never look again, so it stayed stuck on "Syncing…"
// forever if the real Outlook export (which this mocks out) took longer
// than that one delay — which it routinely does. This asserts the status
// actually converges once the import genuinely finishes, however long that
// takes, via repeated polling rather than a single timed check.
test('calendar view: "Syncing…" status clears once the import actually finishes', async ({ page }) => {
  await mockCalendarWeek(page, []);

  // The calendar view also checks status once on open, before the sync
  // button is ever clicked — counting only checks *after* the sync starts
  // (rather than every call) keeps this deterministic regardless of that
  // earlier check.
  let syncStarted = false;
  let statusChecksAfterStart = 0;
  await page.route('**/api/calendar/import', (route) => {
    syncStarted = true;
    route.fulfill({ json: { started: true } });
  });
  await page.route('**/api/calendar/import/status', (route) => {
    let inProgress = false;
    if (syncStarted) {
      statusChecksAfterStart++;
      inProgress = statusChecksAfterStart === 1; // in progress on the first check after starting, done on every check after that
    }
    route.fulfill({
      json: {
        configured: true,
        inProgress,
        lastRunAt: inProgress ? null : new Date().toISOString(),
        lastError: null,
      },
    });
  });

  await page.goto('/');
  await page.click('#calendarBtn');
  await page.click('#calendarSyncBtn');

  await expect(page.locator('#calendarSyncStatus')).toContainText('Syncing');
  await expect(page.locator('#calendarSyncStatus')).toContainText('Last synced', { timeout: 5000 });
});

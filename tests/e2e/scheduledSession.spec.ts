import { execFileSync } from 'child_process';
import { test, expect, Page } from '@playwright/test';
import { config } from '../../src/config';

function soxAvailable(): boolean {
  try {
    execFileSync(config.soxBinary, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Drives the custom calendar/time picker: opens it, uses the "In 1 hour"
// quick-pick (far enough out it never actually fires during a test).
async function scheduleInOneHour(page: Page): Promise<void> {
  await page.click('#scheduledStartTrigger');
  await expect(page.locator('#datetimePicker')).toBeVisible();
  await page.click('.dtp-quick[data-quick="1h"]');
  await expect(page.locator('#datetimePicker')).toBeHidden();
}

// Opens the picker, keeps today's date (selected by default), sets the time
// field to right now — since only HH:MM is settable, the seconds truncate to
// :00, which is already <= the real current time, so the schedule poller
// (20s interval) picks it up on its very next tick instead of waiting out a
// long, precise countdown.
async function scheduleForRightNow(page: Page): Promise<void> {
  await page.click('#scheduledStartTrigger');
  await expect(page.locator('#datetimePicker')).toBeVisible();
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  await page.fill('#dtpTimeInput', hhmm);
  await page.click('#dtpApplyBtn');
  await expect(page.locator('#datetimePicker')).toBeHidden();
}

test('scheduled session: setting a schedule shows it in the sidebar, and it can be canceled', async ({ page }) => {
  await page.goto('/');
  await page.click('#newSessionOpenBtn');

  const sessionName = `e2e-scheduled-${Date.now()}`;
  await page.fill('#nameInput', sessionName);
  await scheduleInOneHour(page);
  await expect(page.locator('#scheduledStartLabel')).not.toHaveText('Pick a date & time');
  await page.click('#saveOnlyBtn');

  await expect(page.locator('#newSessionOverlay')).toBeHidden();

  const card = page.locator('.session-card', { hasText: sessionName });
  await expect(card.locator('.session-schedule')).toContainText('Scheduled for');

  await card.locator('.session-schedule-cancel').click();
  await expect(card.locator('.session-schedule')).toHaveCount(0);
  await expect(card.locator('.session-start-recording')).toBeVisible();
});

// Audio capture is real-hardware-dependent (see liveSession.spec.ts) — skip on
// a machine without SoX resolvable.
test.skip(!soxAvailable(), 'SoX not resolvable on this machine — skipping the scheduled auto-start test.');

test('scheduled session: auto-starts recording at the scheduled time without any manual click', async ({ page }) => {
  await page.goto('/');
  await page.click('#newSessionOpenBtn');

  const sessionName = `e2e-autostart-${Date.now()}`;
  await page.fill('#nameInput', sessionName);
  await scheduleForRightNow(page);
  await page.click('#saveOnlyBtn');

  await expect(page.locator('#newSessionOverlay')).toBeHidden();

  const card = page.locator('.session-card', { hasText: sessionName });
  await expect(card.locator('.session-schedule')).toContainText('Scheduled for');

  // No click on "Start recording" — the schedule poller should do it.
  await expect(card.locator('.session-dot')).toHaveClass(/recording/, { timeout: 60_000 });
  await expect(card.locator('.session-schedule')).toHaveCount(0);

  await page.click('#stopBtn');
});

import { test, expect } from '@playwright/test';
import { createSession, insertFinalSegment, endSession } from './fixtures';

test('past sessions: seeded transcript renders, rename persists, delete removes it', async ({ page }) => {
  const sessionId = `e2e-past-${Date.now()}`;
  const sessionName = `e2e-pastSessions-${Date.now()}`;
  createSession(sessionId, ['en-US'], sessionName, { sessionType: 'personal' });
  insertFinalSegment({ sessionId, speaker: 'Others', startMs: 0, endMs: 2000, text: 'Let us kick off the meeting.', isFinal: true });
  insertFinalSegment({ sessionId, speaker: 'You', startMs: 2000, endMs: 4000, text: 'Sounds good, I am ready.', isFinal: true });
  endSession(sessionId);

  await page.goto('/');
  await expect(page.locator('.session-card', { hasText: sessionName })).toBeVisible();
  await page.click(`.session-card:has-text("${sessionName}")`);

  await expect(page.locator('#mainTitle')).toHaveText(sessionName);
  await expect(page.locator('#transcript')).toContainText('Let us kick off the meeting.');
  await expect(page.locator('#transcript')).toContainText('Sounds good, I am ready.');

  const renamedTo = `${sessionName}-renamed`;
  const mainTitle = page.locator('#mainTitle');
  await mainTitle.click();
  await mainTitle.fill(renamedTo);
  await mainTitle.blur();
  await expect(page.locator('.session-card', { hasText: renamedTo })).toBeVisible();

  await page.reload();
  await expect(page.locator('.session-card', { hasText: renamedTo })).toBeVisible();
  await page.click(`.session-card:has-text("${renamedTo}")`);
  await expect(page.locator('#mainTitle')).toHaveText(renamedTo);

  page.once('dialog', (dialog) => dialog.accept());
  await page.click(`.session-card:has-text("${renamedTo}") .session-delete`);
  await expect(page.locator('.session-card', { hasText: renamedTo })).toBeHidden();

  await page.reload();
  await expect(page.locator('.session-card', { hasText: renamedTo })).toHaveCount(0);
});

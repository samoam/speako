import { test, expect } from '@playwright/test';
import { config } from '../../src/config';
import { createSession, insertFinalSegment, endSession } from './fixtures';

test('summary and coaching: real generation renders in their tabs', async ({ page }) => {
  test.skip(!config.geminiApiKey, 'GEMINI_API_KEY not configured — skipping real summary/coaching generation.');

  const sessionId = `e2e-summary-${Date.now()}`;
  const sessionName = `e2e-summaryAndCoaching-${Date.now()}`;
  createSession(sessionId, ['en-US'], sessionName, { sessionType: 'personal' });
  const lines: Array<[string, string]> = [
    ['Others', "Let's start the sprint review. Can you walk us through what shipped this sprint?"],
    ['You', 'Sure, um, we shipped the new settings page and, like, fixed the SoX audio driver bug on macOS.'],
    ['Others', 'Great, any blockers going into next sprint?'],
    ['You', "Yeah, we're kind of blocked on the mem0 cloud service being slow to cold-start, you know."],
    ['Others', "Okay, let's take that as an action item to investigate."],
  ];
  lines.forEach(([speaker, text], i) => {
    insertFinalSegment({ sessionId, speaker, startMs: i * 5000, endMs: i * 5000 + 4000, text, isFinal: true });
  });
  endSession(sessionId);

  await page.goto('/');
  await page.click(`.session-card:has-text("${sessionName}")`);
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);

  await page.click('#kebabBtn');
  await page.click('#summarizeBtn');
  await page.click('.tab-btn[data-tab="summary"]');
  await expect(page.locator('#summaryContent')).not.toContainText('No summary yet', { timeout: 60_000 });
  await expect(page.locator('#summaryContent')).not.toBeEmpty();

  await page.click('#kebabBtn');
  await page.click('#coachBtn');
  await page.click('.tab-btn[data-tab="coaching"]');
  await expect(page.locator('#coachingContent')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#coachingEmptyState')).toBeHidden();
  await expect(page.locator('#fillerWordCount')).not.toBeEmpty();
});

import { test, expect } from '@playwright/test';
import { config } from '../../src/config';
import { createSession, insertFinalSegment, endSession } from './fixtures';

function seedSession(prefix: string) {
  const sessionId = `e2e-${prefix}-${Date.now()}`;
  const sessionName = `e2e-${prefix}-${Date.now()}`;
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
  return { sessionId, sessionName };
}

test('summary and coaching: real generation renders in their tabs', async ({ page }) => {
  test.skip(!config.geminiApiKey, 'GEMINI_API_KEY not configured — skipping real summary/coaching generation.');
  const { sessionName } = seedSession('summary');

  await page.goto('/');
  await page.click(`.session-card:has-text("${sessionName}")`);
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);

  await page.click('#kebabBtn');
  await page.click('#summarizeBtn');
  await page.click('.tab-btn[data-tab="summary"]');
  await expect(page.locator('#summaryContent')).not.toContainText('No summary yet', { timeout: 60_000 });
  await expect(page.locator('#summaryContent')).not.toBeEmpty();

  // Action items share the summarize call (Promise.all) — if ACTION_ITEMS_SCHEMA
  // were malformed for the real API, the summary assertion above would already
  // have failed (summarize and extract run together and either both succeed or
  // the whole call rejects), but assert on actual content too, not just absence
  // of failure.
  await page.click('.tab-btn[data-tab="actionItems"]');
  await expect(page.locator('#actionItemsContent')).not.toBeEmpty();

  // Topics ride the summary call above — verify they actually made it into the
  // Insights modal's Topics tab, not just that summarize didn't error.
  await page.click('#insightsBtn');
  await page.click('.insights-tab-btn[data-insights-tab="topics"]');
  await expect(page.locator('#insightsTopicsChart .topic-bar-col').first()).toBeVisible({ timeout: 15_000 });

  await page.click('#insightsModalClose');
  await page.click('#kebabBtn');
  await page.click('#coachBtn');
  await page.click('.tab-btn[data-tab="coaching"]');
  await expect(page.locator('#coachingContent')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#coachingEmptyState')).toBeHidden();
  await expect(page.locator('#fillerWordCount')).not.toBeEmpty();
  await expect(page.locator('#interruptionCounts')).not.toBeEmpty();
});

// Independent of summarize/coach — chapters only need an ended session with a
// transcript, so this doesn't get blocked if summarize/coach happen to be
// failing for an unrelated reason (real-API account/model issues, etc).
test('chapters: real detection renders a clickable chapter list', async ({ page }) => {
  test.skip(!config.geminiApiKey, 'GEMINI_API_KEY not configured — skipping real chapter detection.');
  const { sessionName } = seedSession('chapters');

  await page.goto('/');
  await page.click(`.session-card:has-text("${sessionName}")`);
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);

  await page.click('#kebabBtn');
  await page.click('#chaptersBtn');
  await page.locator('#chaptersList .chapter-chip').first().waitFor({ timeout: 60_000 });
  await expect(page.locator('#chaptersList .chapter-chip')).not.toHaveCount(0);
});

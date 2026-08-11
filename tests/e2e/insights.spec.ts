import { test, expect } from '@playwright/test';
import { config } from '../../src/config';

test('insights modal: ask across all my meetings returns a real answer', async ({ page }) => {
  test.skip(!config.geminiApiKey, 'GEMINI_API_KEY not configured — skipping real cross-session Q&A.');

  await page.goto('/');
  await page.click('#insightsBtn');
  await expect(page.locator('#insightsAskWrap')).toBeVisible();

  await page.fill('#insightsAskInput', 'What have I discussed in my meetings recently?');
  await page.click('#insightsAskBtn');

  await expect(page.locator('#insightsAskHistory .qa-pair').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#insightsAskHistory .qa-answer').first()).not.toBeEmpty();
});

import { test, expect } from '@playwright/test';
import { config } from '../../src/config';
import { isJiraConfigured } from '../../src/integrations/jiraMcp';
import { isConfluenceConfigured } from '../../src/integrations/confluenceMcp';

const canRunPrep = !!config.geminiApiKey && (isJiraConfigured() || isConfluenceConfigured());

test('new session modal: type toggle, workflow preview, tool checklist, and a real prep run', async ({ page }) => {
  await page.goto('/');
  await page.click('#newSessionOpenBtn');
  await expect(page.locator('#newSessionOverlay')).toBeVisible();

  await page.click('#workTypeBtn');
  await expect(page.locator('#workPrepBox')).toBeVisible();

  await page.selectOption('#meetingTypeSelect', 'design_dev');
  await expect(page.locator('#workflowPreviewList li').first()).toBeVisible();

  await expect(page.locator('#newSessionToolsChecklist input[data-tool]').first()).toBeAttached();

  const sessionName = `e2e-newSession-${Date.now()}`;
  await page.fill('#nameInput', sessionName);
  await page.click('#prepareBtn');

  await expect(page.locator('#newSessionOverlay')).toBeHidden();
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);

  await page.click('.tab-btn[data-tab="prepBrief"]');
  await expect(page.locator('#prepBriefWrap')).toBeVisible();

  test.skip(!canRunPrep, 'Gemini + Jira/Confluence not configured — skipping real prep-content assertion.');

  await expect(page.locator('#prepBriefText')).not.toHaveValue('', { timeout: 60_000 });
});

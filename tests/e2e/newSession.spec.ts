import { test, expect } from '@playwright/test';
import { config } from '../../src/config';
import { isJiraConfigured } from '../../src/integrations/jiraMcp';
import { isConfluenceConfigured } from '../../src/integrations/confluenceMcp';

const canRunPrep = !!config.geminiApiKey && (isJiraConfigured() || isConfluenceConfigured());

test('new session modal: workflow preview, tool checklist, save (no auto-prep), then "Run prep now"', async ({ page }) => {
  await page.goto('/');
  await page.click('#newSessionOpenBtn');
  await expect(page.locator('#newSessionOverlay')).toBeVisible();

  // Speako is work-only (no personal/work toggle button anymore) — the work
  // prep section is unconditionally visible, nothing to click to reveal it.
  await expect(page.locator('#meetingOnlyFields')).toBeVisible();

  await page.selectOption('#meetingTypeSelect', 'design_dev');
  await expect(page.locator('#workflowPreviewList li').first()).toBeVisible();

  await expect(page.locator('#newSessionToolsChecklist input[data-tool]').first()).toBeAttached();

  const sessionName = `e2e-newSession-${Date.now()}`;
  await page.fill('#nameInput', sessionName);
  await expect(page.locator('#saveOnlyBtn')).toHaveText('Save');
  await page.click('#saveOnlyBtn');

  await expect(page.locator('#newSessionOverlay')).toBeHidden();
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);

  // Prep never runs automatically anymore — it's created with prepStatus
  // 'none' and only starts when explicitly triggered from this tab.
  await page.click('.tab-btn[data-tab="prepBrief"]');
  await expect(page.locator('#prepBriefWrap')).toBeVisible();
  await expect(page.locator('#runPrepBtn')).toBeVisible();
  await expect(page.locator('#runPrepBtn')).toHaveText('Run prep now');

  test.skip(!canRunPrep, 'Gemini + Jira/Confluence not configured — skipping real prep run.');

  await page.click('#runPrepBtn');
  await expect(page.locator('#runPrepBtn')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('#prepBriefText')).not.toHaveValue('', { timeout: 60_000 });
});

test('new session modal: "Chat with AI" in the type dropdown hides meeting-only fields and starts a chat instead', async ({ page }) => {
  await page.goto('/');
  await page.click('#newSessionOpenBtn');
  await expect(page.locator('#newSessionOverlay')).toBeVisible();
  await expect(page.locator('#meetingOnlyFields')).toBeVisible();

  await page.selectOption('#meetingTypeSelect', 'chat');
  await expect(page.locator('#meetingOnlyFields')).toBeHidden();
  await expect(page.locator('#saveOnlyBtn')).toHaveText('Start chat');
  // Tools still apply to a chat session — that checklist stays visible.
  await expect(page.locator('#newSessionToolsChecklist')).toBeVisible();

  await page.click('#saveOnlyBtn');
  await expect(page.locator('#newSessionOverlay')).toBeHidden();

  // A chat session opens in #main once the server confirms 'voice-ready' —
  // #main is the app's default-hidden view now (the Dashboard board is the
  // default), so this is the regression #main's reveal here would actually
  // catch. #liveChatLog itself isn't a reliable visibility target: it's an
  // empty flex container until the model's first reply bubble lands, so it
  // has no rendered box size to assert on — and with a fake, silent mic
  // stream the real Gemini Live connection can also end the session again
  // within seconds, so a bubble may never arrive at all.
  await expect(page.locator('#main')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#mainTitle')).not.toBeEmpty();
});

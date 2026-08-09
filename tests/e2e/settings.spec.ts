import { test, expect } from '@playwright/test';

// Uses #setting-waveformEnabled (a plain feature-toggle checkbox, no secret
// value) to verify the round trip through GET/PUT /api/settings ->
// settingsStore.ts -> the SQLite `settings` table. Every other field in this
// modal echoes the real, unmasked credentials from .env (see
// serializeSettingValue in server.ts) — saving re-submits them unchanged, so
// nothing is at risk, but a failed assertion's trace/snapshot would still
// capture the whole DOM including those real values. Trace/screenshot are
// disabled for this file specifically so a failure here never writes
// credentials to disk, gitignore notwithstanding.
test.use({ trace: 'off', screenshot: 'off' });

test('settings: a toggled value persists across reload', async ({ page }) => {
  await page.goto('/');
  await page.click('#settingsBtn');
  await expect(page.locator('#settingsOverlay')).toBeVisible();

  const toggle = page.locator('#setting-waveformEnabled');
  await expect(toggle).toBeAttached();
  // The settings modal body scrolls independently of the page — Playwright's
  // default actionability auto-scroll doesn't reliably reach into it, so
  // scroll explicitly before interacting.
  await toggle.scrollIntoViewIfNeeded();
  const before = await toggle.isChecked();

  if (before) await toggle.uncheck();
  else await toggle.check();

  await page.click('#settingsSaveBtn');
  await expect(page.locator('#settingsOverlay')).toBeHidden();

  await page.reload();
  await page.click('#settingsBtn');
  await expect(page.locator('#setting-waveformEnabled')).toBeChecked({ checked: !before });

  await page.click('#settingsCancelBtn');
});

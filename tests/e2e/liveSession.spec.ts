import { execFileSync } from 'child_process';
import { test, expect } from '@playwright/test';
import { config } from '../../src/config';

function soxAvailable(): boolean {
  try {
    execFileSync(config.soxBinary, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Audio capture (src/audio-capture/soxCapture.ts) is a server-side child
// process reading the real OS microphone — entirely independent of the
// browser. There's no clean way to fake it (Windows won't spawn a .bat/.cmd
// stub without shell:true, which the production spawn call doesn't use), so
// this test uses the real SoX binary and skips on a machine without one.
// Content of whatever gets transcribed is non-deterministic — only
// structural recording state is asserted.
test.skip(!soxAvailable(), 'SoX not resolvable on this machine — skipping the live-recording test.');

test('live session: start recording, real audio pipeline runs, stop, appears in history', async ({ page }) => {
  await page.goto('/');
  await page.click('#newSessionOpenBtn');

  const sessionName = `e2e-liveSession-${Date.now()}`;
  await page.fill('#nameInput', sessionName);
  // Prep never runs at creation time anymore regardless — this test is
  // exercising the audio/transcription pipeline, not prep, so there's no
  // real Gemini/Jira/Confluence round-trip to wait on either way.
  await page.click('#saveOnlyBtn');

  await expect(page.locator('#newSessionOverlay')).toBeHidden();
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);
  await page.click('#mainStartBtn');

  await expect(page.locator('#mainMeta')).toHaveClass(/recording/, { timeout: 15_000 });
  await expect(page.locator('#stopBtn')).toBeVisible();

  // Give the real SoX process a moment to actually be capturing before stopping.
  await page.waitForTimeout(3_000);

  await page.click('#stopBtn');
  await expect(page.locator('#stopBtn')).toBeHidden();
  await expect(page.locator('#mainMeta')).not.toHaveClass(/recording/, { timeout: 15_000 });

  await expect(page.locator('.session-card', { hasText: sessionName })).toBeVisible();
});

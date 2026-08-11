import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, E2E_DB_PATH } from './tests/e2e/env';

export default defineConfig({
  testDir: './tests/e2e',
  // Default per-test timeout is 30s, which silently truncates any explicit
  // longer expect() timeout inside a test (real Gemini/Jira/Confluence calls
  // through the full HTTP + workflow path routinely take longer than that).
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx ts-node src/index.ts start',
    url: `http://localhost:${E2E_PORT}/api/status`,
    reuseExistingServer: !process.env.CI,
    // ts-node has to type-check + transpile the whole src/ tree cold (no
    // build cache) before the server can even start listening — the
    // codebase has grown substantially since this was first set to 30s, and
    // that's no longer reliably enough, especially under any system load.
    timeout: 60_000,
    env: {
      // Real .env credentials AND the real GCP_PROJECT_ID flow through
      // untouched (dotenv.config() inside src/config.ts reads .env directly,
      // regardless of what's set here) — same "hit real services" philosophy
      // as Phase 2's integration tier, now driven through the actual browser
      // UI. Unlike the other tiers, liveSession.spec.ts makes a real Speech-
      // to-Text call, which needs the real project — a 'test-project'
      // fallback here would silently point it at a nonexistent project.
      DB_PATH: E2E_DB_PATH,
      HTTP_PORT: String(E2E_PORT),
    },
  },
});

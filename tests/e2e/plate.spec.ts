import { test, expect, Page, Route } from '@playwright/test';
import { config } from '../../src/config';
import { createSession } from './fixtures';

/**
 * GET /api/plate is a plain DB read (no external calls itself — those only
 * happen inside POST /api/plate/sync), so mocking it gives fully
 * deterministic rendering/dismiss/click-through assertions without touching
 * real Jira/Bitbucket, matching calendar.spec.ts's precedent for the one
 * other route in this suite that would otherwise depend on live external
 * state. The mock is stateful (a closure-held array), so a dismiss's
 * follow-up GET reflects the removal — same behavior the real repository
 * gives via its (source, external_ref) status column.
 */
function mockPlate(page: Page, initialTasks: any[]): Promise<void> {
  let tasks = initialTasks;
  return page.route('**/api/plate**', (route: Route) => {
    const url = route.request().url();
    if (route.request().method() === 'POST' && /\/api\/plate\/\d+\/dismiss$/.test(url)) {
      const id = Number(url.match(/\/api\/plate\/(\d+)\/dismiss$/)![1]);
      tasks = tasks.filter((t) => t.id !== id);
      route.fulfill({ json: { dismissed: true } });
      return;
    }
    route.fulfill({ json: tasks });
  });
}

// The task queue is the sidebar's permanent content now (#sidebarQueueList),
// not a modal you open — it's already visible/populated the moment the page
// loads, since the Dashboard board is the app's default main-frame view too.
test('sidebar queue: renders mocked tasks, dismiss removes one, clicking an action-item opens its session', async ({ page }) => {
  const sessionId = `e2e-plate-${Date.now()}`;
  const sessionName = `e2e-plate-session-${Date.now()}`;
  createSession(sessionId, ['en-US'], sessionName, {});

  await mockPlate(page, [
    { id: 1001, source: 'jira', externalRef: 'ETICK-1', title: 'ETICK-1: Fix login bug', description: 'Status: In Progress', url: 'https://jira.example/browse/ETICK-1', dueDate: null, urgencyScore: 4, importanceScore: 5, priorityScore: 20, status: 'open' },
    { id: 1002, source: 'bitbucket_pr', externalRef: 'PROJ/repo#42', title: 'Review: Add caching', description: 'PROJ/repo#42 by alice', url: 'https://bitbucket.example/PROJ/repo/pr/42', dueDate: null, urgencyScore: 3, importanceScore: 4, priorityScore: 12, status: 'open' },
    { id: 1003, source: 'action_item', externalRef: '999', title: 'Follow up with design team', description: `From: ${sessionName}`, url: `session://${sessionId}`, dueDate: null, urgencyScore: 2, importanceScore: 4, priorityScore: 8, status: 'open' },
  ]);

  await page.goto('/');
  await expect(page.locator('#sidebarQueueEmptyState')).toBeHidden();

  const jiraCard = page.locator('#sidebarQueueList .plate-task', { hasText: 'ETICK-1' });
  await expect(jiraCard).toBeVisible();
  await expect(jiraCard.locator('.plate-task-source')).toHaveText('Jira');
  await expect(jiraCard.locator('a')).toHaveAttribute('href', 'https://jira.example/browse/ETICK-1');

  const bitbucketCard = page.locator('#sidebarQueueList .plate-task', { hasText: 'Add caching' });
  await expect(bitbucketCard).toBeVisible();
  await expect(bitbucketCard.locator('.plate-task-source')).toHaveText('Bitbucket');

  // Highest priority_score (Jira, 20) sorted before the lower ones — the
  // mock already returns them pre-sorted, same as the real repository's
  // ORDER BY priority_score DESC, so this just confirms rendering preserves it.
  const titles = await page.locator('#sidebarQueueList .plate-task-title').allTextContents();
  assertDescendingByFirstAppearance(titles, ['ETICK-1', 'Add caching', 'Follow up with design team']);

  await jiraCard.locator('.plate-task-dismiss').click();
  await expect(jiraCard).toBeHidden();
  await expect(bitbucketCard).toBeVisible();

  const actionItemCard = page.locator('#sidebarQueueList .plate-task', { hasText: 'Follow up with design team' });
  await actionItemCard.locator('.plate-task-title').click();
  await expect(page.locator('#mainTitle')).toHaveText(sessionName);
});

function assertDescendingByFirstAppearance(actual: string[], expectedOrder: string[]) {
  const indices = expectedOrder.map((needle) => actual.findIndex((t) => t.includes(needle)));
  for (let i = 1; i < indices.length; i++) {
    expect(indices[i - 1]).toBeLessThan(indices[i]);
  }
}

test('sidebar queue: empty state shows when there are no open tasks', async ({ page }) => {
  await mockPlate(page, []);
  await page.goto('/');
  await expect(page.locator('#sidebarQueueEmptyState')).toBeVisible();
});

test('Dashboard board: "Sync now" runs the real orchestrator sync against configured Jira', async ({ page }) => {
  test.skip(!config.jiraUrl || !config.jiraPersonalToken, 'Jira not configured — skipping real orchestrator sync.');

  // The Dashboard board is the app's default main-frame view — no toggle to click first.
  await page.goto('/');
  await page.click('#plateSyncBtn');
  await expect(page.locator('#plateSyncBtn')).toBeDisabled();

  // Real sync (Jira JQL, read-only) — bounded by the suite's 120s test timeout.
  await expect(page.locator('#plateSyncBtn')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#plateSyncStatus')).toContainText('Last synced');
});

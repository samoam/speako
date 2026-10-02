import { test, expect, Page, Route } from '@playwright/test';

/**
 * Smoke test for the single-file UI: index.html has no build step, so a
 * TDZ error or a typo in a WebSocket handler only shows up when a browser
 * actually loads the page. This loads it, opens a PR review against mocked
 * API routes, then pushes run-* messages through the live WebSocket
 * handler (the same path the server's broadcast takes) and checks the
 * checklist/log react — failing on any page error or console error along
 * the way.
 */

const PR_TASK = {
  id: 1002,
  source: 'bitbucket_pr',
  externalRef: 'PROJ/repo#42',
  title: 'Review: Add caching',
  description: 'PROJ/repo#42 by alice',
  url: 'https://bitbucket.example/PROJ/repo/pr/42',
  dueDate: null,
  urgencyScore: 3,
  importanceScore: 4,
  priorityScore: 12,
  status: 'open',
  myReviewStatus: 'NEW',
};

const REVIEW_REQUEST = {
  id: 7,
  taskId: 1002,
  repoName: 'repo',
  branchName: 'feature/caching',
  status: 'running',
  context: { authorName: 'alice', jiraIssues: [{ key: 'ETICK-1', summary: 'Cache it', status: 'In Progress' }], confluencePages: [] },
  review: null,
  error: null,
  log: ['[2026-10-01T10:00:00.000Z] Fetched PR details.'],
  phases: [
    { key: 'context', label: 'Gather PR & ticket context', status: 'done', detail: '1 Jira ticket(s).' },
    { key: 'worktree', label: 'Check out branch', status: 'running', detail: null },
    { key: 'claude_review', label: 'Run Claude Code review', status: 'pending', detail: null },
  ],
  runId: 3,
  createdAt: '2026-10-01 10:00:00',
  resolvedAt: null,
};

function mockApi(page: Page): Promise<void> {
  return page.route('**/api/plate**', (route: Route) => {
    const url = route.request().url();
    if (/\/api\/plate\/1002\/review$/.test(url)) {
      route.fulfill({ json: REVIEW_REQUEST });
      return;
    }
    if (/\/api\/plate(\?.*)?$/.test(url)) {
      route.fulfill({ json: [PR_TASK] });
      return;
    }
    // Task Detail's side fetches (pr-summary, chat, message) — empty is a valid answer for each.
    route.fulfill({ json: {} });
  });
}

/** Feeds a message to the page's WebSocket handler exactly as the server's broadcast would arrive. */
async function pushWsMessage(page: Page, message: Record<string, unknown>): Promise<void> {
  // controlSocket is the live WebSocket (index.html's connect()); its
  // onmessage is the dispatch into WS_HANDLERS. It's a script-level `let`,
  // not a window property, so this has to be a string evaluated in the
  // page's global scope — a function argument would be compiled apart from
  // the page script and not see it.
  await page.evaluate(`controlSocket.onmessage({ data: ${JSON.stringify(JSON.stringify(message))} })`);
}

test('page loads without script errors, PR review renders a run and reacts to live run-* messages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });

  await mockApi(page);
  await page.goto('/');
  const card = page.locator('#sidebarQueueList .plate-task', { hasText: 'Add caching' });
  await expect(card).toBeVisible();

  // The compact sidebar card opens Task Detail; "Open review" is one of its actions.
  await card.locator('.plate-task-title').click();
  await page.locator('.plate-task-detail-actions .plate-review-btn').click();
  const phases = page.locator('#taskDetailPrReviewPhases');
  await expect(phases.locator('.pr-review-phase')).toHaveCount(3);
  await expect(phases.locator('[data-phase-key="worktree"]')).toHaveClass(/pr-review-phase-running/);
  await expect(page.locator('#taskDetailPrReviewLog .pr-review-log-line')).toHaveCount(1);

  // Live updates for the review on screen (kind + subjectId match)…
  await pushWsMessage(page, { type: 'run-step', runId: 3, kind: 'pr_review', subjectKind: 'task', subjectId: '1002', step: { key: 'worktree', label: 'Check out branch', status: 'done', detail: 'Checked out feature/caching.' } });
  await pushWsMessage(page, { type: 'run-log', runId: 3, kind: 'pr_review', subjectKind: 'task', subjectId: '1002', message: 'Worktree ready.' });
  await expect(phases.locator('[data-phase-key="worktree"]')).toHaveClass(/pr-review-phase-done/);
  await expect(phases.locator('[data-phase-key="worktree"] .pr-review-phase-detail')).toHaveText('Checked out feature/caching.');
  await expect(page.locator('#taskDetailPrReviewLog .pr-review-log-line')).toHaveCount(2);
  await expect(page.locator('#taskDetailPrReviewLog .pr-review-log-line').last()).toContainText('Worktree ready.');

  // …and none for a different subject or kind.
  await pushWsMessage(page, { type: 'run-log', runId: 4, kind: 'pr_review', subjectKind: 'task', subjectId: '9999', message: 'other task' });
  await pushWsMessage(page, { type: 'run-log', runId: 5, kind: 'dev_cycle', subjectKind: 'dev_cycle', subjectId: '1002', message: 'other kind' });
  await expect(page.locator('#taskDetailPrReviewLog .pr-review-log-line')).toHaveCount(2);

  // An unknown message type is ignored, not an exception.
  await pushWsMessage(page, { type: 'no-such-message' });

  expect(errors, errors.join('\n')).toEqual([]);
});

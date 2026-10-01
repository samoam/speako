import test from 'node:test';
import assert from 'node:assert/strict';
import { unstampLogLine } from '../src/storage/logLine';

/** Log lines carry a "[<ISO time>] " prefix (src/storage/logLine.ts) — checks it's there, then compares the messages. */
function assertStampedLog(log: string[] | undefined, expected: string[]): void {
  assert.ok(log && log.every((line) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] /.test(line)), `every line should be time-stamped: ${JSON.stringify(log)}`);
  assert.deepEqual(log!.map(unstampLogLine), expected);
}

import { upsertTask, getOpenTasks } from '../src/storage/taskRepository';
import {
  createPrReviewRequest,
  getPrReviewRequest,
  getLatestPrReviewRequestForTask,
  setPrReviewContext,
  appendPrReviewLog,
  markPrReviewReady,
  markPrReviewFailed,
  failInterruptedPrReviews,
  initPrReviewPhases,
  setPrReviewPhase,
} from '../src/storage/prReviewRequestRepository';

function seedTask(externalRef: string): number {
  upsertTask({ source: 'bitbucket_pr', externalRef, title: 'Add caching', urgencyScore: 3, importanceScore: 3 });
  return getOpenTasks().find((t) => t.externalRef === externalRef)!.id;
}

test('createPrReviewRequest: defaults to status "running", round-trips via getPrReviewRequest', () => {
  const taskId = seedTask('PROJ/repo#1');
  const request = createPrReviewRequest({ taskId, repoName: 'officercc', branchName: 'feature/caching' });
  assert.equal(request.status, 'running');
  assert.equal(request.taskId, taskId);
  assert.equal(request.branchName, 'feature/caching');
  assert.equal(request.context, null);
  assert.equal(request.review, null);

  assert.deepEqual(getPrReviewRequest(request.id), request);
});

test('getLatestPrReviewRequestForTask: returns the most recent of several requests', () => {
  const taskId = seedTask('PROJ/repo#2');
  const first = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b1' });
  const second = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b2' });

  const latest = getLatestPrReviewRequestForTask(taskId);
  assert.equal(latest?.id, second.id);
  assert.notEqual(latest?.id, first.id);
});

test('setPrReviewContext: stores and round-trips the gathered Jira/Confluence context as JSON', () => {
  const taskId = seedTask('PROJ/repo#3');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  setPrReviewContext(request.id, {
    jiraIssues: [{ key: 'ETICK-1', summary: 'Fix it', status: 'In Progress' }],
    confluencePages: [{ title: 'Design Doc' }],
  });
  const updated = getPrReviewRequest(request.id)!;
  assert.deepEqual(updated.context, {
    jiraIssues: [{ key: 'ETICK-1', summary: 'Fix it', status: 'In Progress' }],
    confluencePages: [{ title: 'Design Doc' }],
  });
});

test('markPrReviewReady: sets status, structured review, and resolvedAt', () => {
  const taskId = seedTask('PROJ/repo#4');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  const review = {
    summary: 'Looks good overall.',
    recommendation: 'approve' as const,
    findings: [{ file: 'src/foo.ts', line: 12, severity: 'minor' as const, comment: 'Consider renaming this.' }],
  };
  markPrReviewReady(request.id, review);
  const updated = getPrReviewRequest(request.id)!;
  assert.equal(updated.status, 'ready');
  assert.deepEqual(updated.review, review);
  assert.ok(updated.resolvedAt);
});

test('markPrReviewFailed: sets status, error, and resolvedAt', () => {
  const taskId = seedTask('PROJ/repo#5');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  markPrReviewFailed(request.id, 'branch checkout failed');
  const updated = getPrReviewRequest(request.id)!;
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'branch checkout failed');
  assert.ok(updated.resolvedAt);
});

test('createPrReviewRequest: starts with an empty log', () => {
  const taskId = seedTask('PROJ/repo#6');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  assert.deepEqual(request.log, []);
});

test('markPrReviewReady: strips leaked tool-call closing tags from summary and finding comments', () => {
  const taskId = seedTask('PROJ/repo#8');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  markPrReviewReady(request.id, {
    summary: 'This PR fixes the race.</parameter>\n</invoke>\n',
    recommendation: 'approve',
    findings: [{ file: 'src/foo.ts', line: 12, severity: 'minor', comment: 'Consider renaming this.</parameter>' }],
  });
  const updated = getPrReviewRequest(request.id)!;
  assert.equal(updated.review?.summary, 'This PR fixes the race.');
  assert.equal(updated.review?.findings[0].comment, 'Consider renaming this.');
});

test('appendPrReviewLog: appends progress lines in order, preserving earlier ones', () => {
  const taskId = seedTask('PROJ/repo#7');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  appendPrReviewLog(request.id, 'Fetched PR details.');
  appendPrReviewLog(request.id, 'Checking Jira ticket(s)...');
  const updated = getPrReviewRequest(request.id)!;
  assertStampedLog(updated.log, ['Fetched PR details.', 'Checking Jira ticket(s)...']);
});

test('createPrReviewRequest: starts with an empty phases list', () => {
  const taskId = seedTask('PROJ/repo#8');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  assert.deepEqual(request.phases, []);
});

test('initPrReviewPhases: seeds the full step list as given', () => {
  const taskId = seedTask('PROJ/repo#9');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  const phases = [
    { key: 'context', label: 'Gather PR & ticket context', status: 'pending' as const, detail: null },
    { key: 'worktree', label: 'Check out branch', status: 'pending' as const, detail: null },
  ];
  initPrReviewPhases(request.id, phases);
  assert.deepEqual(getPrReviewRequest(request.id)!.phases, phases);
});

test('setPrReviewPhase: updates only the matching phase by key, leaving the others untouched', () => {
  const taskId = seedTask('PROJ/repo#10');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  initPrReviewPhases(request.id, [
    { key: 'context', label: 'Gather context', status: 'pending', detail: null },
    { key: 'worktree', label: 'Check out branch', status: 'pending', detail: null },
  ]);

  setPrReviewPhase(request.id, 'context', 'running');
  let phases = getPrReviewRequest(request.id)!.phases;
  assert.equal(phases[0].status, 'running');
  assert.equal(phases[0].detail, null);
  assert.equal(phases[1].status, 'pending');

  setPrReviewPhase(request.id, 'context', 'done', '2 Jira ticket(s), 1 Confluence page(s).');
  phases = getPrReviewRequest(request.id)!.phases;
  assert.equal(phases[0].status, 'done');
  assert.equal(phases[0].detail, '2 Jira ticket(s), 1 Confluence page(s).');
  assert.equal(phases[1].status, 'pending', 'the worktree phase should be untouched by an update to context');
});

test('setPrReviewPhase: is a no-op (does not throw) for an unknown key', () => {
  const taskId = seedTask('PROJ/repo#11');
  const request = createPrReviewRequest({ taskId, repoName: 'r', branchName: 'b' });
  initPrReviewPhases(request.id, [{ key: 'context', label: 'Gather context', status: 'pending', detail: null }]);
  assert.doesNotThrow(() => setPrReviewPhase(request.id, 'nonexistent', 'done'));
  assert.deepEqual(getPrReviewRequest(request.id)!.phases, [{ key: 'context', label: 'Gather context', status: 'pending', detail: null }]);
});

test('failInterruptedPrReviews: fails every still-running review (orphaned by a restart) and leaves finished ones alone', () => {
  const running = createPrReviewRequest({ taskId: seedTask('restart-running'), repoName: 'officercc', branchName: 'feature/x' });
  const done = createPrReviewRequest({ taskId: seedTask('restart-done'), repoName: 'officercc', branchName: 'feature/y' });
  markPrReviewReady(done.id, { summary: 's', recommendation: 'approve', findings: [] });
  const reset = failInterruptedPrReviews('Interrupted — Speako restarted while this review was running.');
  assert.ok(reset >= 1);
  assert.equal(getPrReviewRequest(running.id)!.status, 'failed');
  assert.match(getPrReviewRequest(running.id)!.error ?? '', /restarted/);
  assert.equal(getPrReviewRequest(done.id)!.status, 'ready');
});

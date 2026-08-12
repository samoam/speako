import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/storage/segmentRepository';
import { db } from '../src/storage/db';
import {
  createCodeChangeRequest,
  getCodeChangeRequest,
  getLatestCodeChangeRequestForActionItem,
  getRunningCodeChangeRequests,
  markCodeChangeReady,
  markCodeChangeFailed,
  markCodeChangeApplied,
  markCodeChangePushed,
  markCodeChangeDiscarded,
} from '../src/storage/codeChangeRequestRepository';

function seedActionItem(sessionId: string, description: string): number {
  const result = db
    .prepare("INSERT INTO action_items (session_id, description, confidence) VALUES (?, ?, 'explicit')")
    .run(sessionId, description);
  return result.lastInsertRowid as number;
}

test('createCodeChangeRequest: defaults to status "running", round-trips via getCodeChangeRequest', () => {
  createSession('ccr-session-1', ['en-US'], 'Test session');
  const actionItemId = seedActionItem('ccr-session-1', 'Fix the bug');
  const request = createCodeChangeRequest({
    actionItemId,
    sessionId: 'ccr-session-1',
    repoName: 'officercc',
    repoPath: 'C:\\fake\\path',
    cliSessionId: 'abc123',
  });
  assert.equal(request.status, 'running');
  assert.equal(request.actionItemId, actionItemId);
  assert.equal(request.repoName, 'officercc');
  assert.equal(request.cliSessionId, 'abc123');
  assert.equal(request.worktreePath, null);
  assert.equal(request.diff, null);

  const fetched = getCodeChangeRequest(request.id);
  assert.deepEqual(fetched, request);
});

test('getLatestCodeChangeRequestForActionItem: returns the most recent of several requests', () => {
  createSession('ccr-session-2', ['en-US'], 'Test session 2');
  const actionItemId = seedActionItem('ccr-session-2', 'Add a feature');
  const first = createCodeChangeRequest({ actionItemId, sessionId: 'ccr-session-2', repoName: 'r', repoPath: 'p', cliSessionId: 'first' });
  const second = createCodeChangeRequest({ actionItemId, sessionId: 'ccr-session-2', repoName: 'r', repoPath: 'p', cliSessionId: 'second' });

  const latest = getLatestCodeChangeRequestForActionItem(actionItemId);
  assert.equal(latest?.id, second.id);
  assert.notEqual(latest?.id, first.id);
});

test('markCodeChangeReady: sets status, worktreePath, and diff', () => {
  createSession('ccr-session-3', ['en-US'], 'Test session 3');
  const actionItemId = seedActionItem('ccr-session-3', 'Refactor module');
  const request = createCodeChangeRequest({ actionItemId, sessionId: 'ccr-session-3', repoName: 'r', repoPath: 'p', cliSessionId: 'c1' });

  markCodeChangeReady(request.id, 'C:\\worktree\\path', 'diff --git a/x.ts b/x.ts\n+added line');

  const updated = getCodeChangeRequest(request.id)!;
  assert.equal(updated.status, 'ready');
  assert.equal(updated.worktreePath, 'C:\\worktree\\path');
  assert.match(updated.diff!, /added line/);
});

test('markCodeChangeFailed: sets status, error, and resolvedAt', () => {
  createSession('ccr-session-4', ['en-US'], 'Test session 4');
  const actionItemId = seedActionItem('ccr-session-4', 'Do something');
  const request = createCodeChangeRequest({ actionItemId, sessionId: 'ccr-session-4', repoName: 'r', repoPath: 'p', cliSessionId: 'c2' });

  markCodeChangeFailed(request.id, 'boom');

  const updated = getCodeChangeRequest(request.id)!;
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'boom');
  assert.ok(updated.resolvedAt);
});

test('markCodeChangeApplied -> markCodeChangePushed: status transitions correctly, resolvedAt only set at push', () => {
  createSession('ccr-session-5', ['en-US'], 'Test session 5');
  const actionItemId = seedActionItem('ccr-session-5', 'Ship it');
  const request = createCodeChangeRequest({ actionItemId, sessionId: 'ccr-session-5', repoName: 'r', repoPath: 'p', cliSessionId: 'c3' });
  markCodeChangeReady(request.id, 'C:\\wt', 'diff');

  markCodeChangeApplied(request.id);
  const applied = getCodeChangeRequest(request.id)!;
  assert.equal(applied.status, 'applied');
  assert.equal(applied.resolvedAt, null);

  markCodeChangePushed(request.id);
  const pushed = getCodeChangeRequest(request.id)!;
  assert.equal(pushed.status, 'pushed');
  assert.ok(pushed.resolvedAt);
});

test('markCodeChangeDiscarded: sets status and resolvedAt', () => {
  createSession('ccr-session-6', ['en-US'], 'Test session 6');
  const actionItemId = seedActionItem('ccr-session-6', 'Never mind');
  const request = createCodeChangeRequest({ actionItemId, sessionId: 'ccr-session-6', repoName: 'r', repoPath: 'p', cliSessionId: 'c4' });

  markCodeChangeDiscarded(request.id);

  const updated = getCodeChangeRequest(request.id)!;
  assert.equal(updated.status, 'discarded');
  assert.ok(updated.resolvedAt);
});

test('getRunningCodeChangeRequests: only returns requests still in "running" status', () => {
  createSession('ccr-session-7', ['en-US'], 'Test session 7');
  const item1 = seedActionItem('ccr-session-7', 'Item one');
  const item2 = seedActionItem('ccr-session-7', 'Item two');
  const running = createCodeChangeRequest({ actionItemId: item1, sessionId: 'ccr-session-7', repoName: 'r', repoPath: 'p', cliSessionId: 'running-1' });
  const done = createCodeChangeRequest({ actionItemId: item2, sessionId: 'ccr-session-7', repoName: 'r', repoPath: 'p', cliSessionId: 'done-1' });
  markCodeChangeDiscarded(done.id);

  const stillRunning = getRunningCodeChangeRequests().map((r) => r.id);
  assert.ok(stillRunning.includes(running.id));
  assert.ok(!stillRunning.includes(done.id));
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { threadsNeedingResponse, buildTriagePrompt, buildFeedbackChangesPrompt, watchDevCyclePr, prRefOf } from '../src/dev/prFeedback';
import { BitbucketPullRequestComment } from '../src/integrations/bitbucketServer';
import * as bitbucket from '../src/integrations/bitbucketServer';
import * as draftService from '../src/drafts/draftService';
import * as claudeCodeCli from '../src/integrations/claudeCodeCli';
import { createDevCycle, getDevCycle, setDevCyclePr } from '../src/storage/devCycleRepository';
import { DevCycleFeedback } from '../src/storage/devCycleFeedbackRepository';

function comment(p: Partial<BitbucketPullRequestComment> & { commentId: number; authorUsername: string; text: string; createdDate: string }): BitbucketPullRequestComment {
  return { prId: 1, prTitle: 'PR', projectKey: 'P', repoSlug: 'r', authorName: p.authorUsername.toUpperCase(), rootCommentId: p.commentId, anchor: null, ...p };
}

test('threadsNeedingResponse: reviewer threads where the reviewer had the last word, with the whole conversation as text', () => {
  const comments = [
    // A reviewer thread nobody answered yet.
    comment({ commentId: 10, authorUsername: 'alice', text: 'Rename this.', createdDate: '2026-10-01T10:00:00Z', anchor: { path: 'dst://src/A.java', line: 5, lineType: 'ADDED' } as any }),
    // A reviewer thread we already answered — not pending.
    comment({ commentId: 20, authorUsername: 'bob', text: 'Why?', createdDate: '2026-10-01T10:01:00Z' }),
    comment({ commentId: 21, rootCommentId: 20, authorUsername: 'madadi', text: 'Because.', createdDate: '2026-10-01T10:02:00Z' }),
    // A thread we answered and the reviewer came back on — pending again, with the follow-up.
    comment({ commentId: 30, authorUsername: 'bob', text: 'Null check?', createdDate: '2026-10-01T10:03:00Z' }),
    comment({ commentId: 31, rootCommentId: 30, authorUsername: 'madadi', text: 'Not needed.', createdDate: '2026-10-01T10:04:00Z' }),
    comment({ commentId: 32, rootCommentId: 30, authorUsername: 'bob', text: 'It is: see line 9.', createdDate: '2026-10-01T10:05:00Z' }),
    // Our own top-level comment with a reviewer reply — the reviewer is answering us, nothing to do.
    comment({ commentId: 40, authorUsername: 'madadi', text: 'FYI I kept the old name.', createdDate: '2026-10-01T10:06:00Z' }),
    comment({ commentId: 41, rootCommentId: 40, authorUsername: 'alice', text: 'ok', createdDate: '2026-10-01T10:07:00Z' }),
  ];
  const threads = threadsNeedingResponse(comments, 'MADADI');
  assert.deepEqual(threads.map((t) => t.rootCommentId), [10, 30]);
  assert.deepEqual(threads[0], { rootCommentId: 10, author: 'ALICE', text: 'ALICE: Rename this.', anchorPath: 'src/A.java', anchorLine: 5 });
  assert.equal(threads[1].text, 'BOB: Null check?\nme: Not needed.\nBOB: It is: see line 9.');
  assert.equal(threads[1].anchorPath, null);
});

const item = (over: Partial<DevCycleFeedback>): DevCycleFeedback => ({
  id: 1, devCycleId: 1, rootCommentId: 10, author: 'Alice', text: 'Alice: Rename this.', anchorPath: 'src/A.java', anchorLine: 5, round: 1, status: 'open', action: null, reply: null, changeInstruction: null, replyCommentId: null, resolved: false, createdAt: '', handledAt: null, ...over,
});

test('buildTriagePrompt: every thread listed with its id, author and anchor; the pass is read-only', () => {
  const prompt = buildTriagePrompt({ ticketKey: 'ETICK-1', prTitle: 'ETICK-1 thing', branch: 'feature/ETICK-1', baseBranch: 'master', items: [item({ id: 7 }), item({ id: 8, anchorPath: null, anchorLine: null, author: 'Bob', text: 'Bob: Why?' })] });
  assert.match(prompt, /#7 — Alice on src\/A\.java:5:\nAlice: Rename this\./);
  assert.match(prompt, /#8 — Bob \(general comment\):\nBob: Why\?/);
  assert.match(prompt, /do not modify any file/);
  assert.match(prompt, /feature\/ETICK-1 into master/);
});

test('buildFeedbackChangesPrompt: only the change instructions, one per thread', () => {
  const prompt = buildFeedbackChangesPrompt({ ticketKey: 'ETICK-1', prTitle: 'T', items: [item({ id: 7, changeInstruction: 'Rename foo to bar.' })] });
  assert.match(prompt, /Thread #7 \(src\/A\.java:5\)/);
  assert.match(prompt, /Change to make: Rename foo to bar\./);
  assert.match(prompt, /nothing else/);
});

function cycleWithPr(key: string) {
  const c = createDevCycle({ ticketKey: key, repoName: 'r', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCyclePr(c.id, { projectKey: 'P', repoSlug: 'r', prId: 42, prUrl: 'https://bb/pr/42' });
  return getDevCycle(c.id)!;
}

test('prRefOf: null until the cycle has a PR', () => {
  const c = createDevCycle({ ticketKey: 'FBW-0', repoName: 'r', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  assert.equal(prRefOf(c), null);
  assert.deepEqual(prRefOf(cycleWithPr('FBW-0b')), { id: 42, projectKey: 'P', repoSlug: 'r' });
});

test('watchDevCyclePr: MERGED closes the cycle as done and starts the QA Ready transition draft', async (t) => {
  t.mock.method(bitbucket, 'getPullRequest', async () => ({ id: 42, title: 'T', state: 'MERGED' }) as any);
  t.mock.method(claudeCodeCli, 'removeWorktree', async () => {});
  const started: any[] = [];
  t.mock.method(draftService, 'startDraft', async (p: any) => {
    started.push(p);
    return {} as any;
  });
  const c = cycleWithPr('FBW-1');
  assert.deepEqual(await watchDevCyclePr(c), { kind: 'merged' });
  assert.equal(getDevCycle(c.id)!.status, 'done');
  assert.deepEqual(started, [{ kind: 'jira_transition', subjectId: `${c.id}:QA Ready` }]);
});

test('watchDevCyclePr: DECLINED abandons the cycle; OPEN returns the threads waiting on the author', async (t) => {
  const c = cycleWithPr('FBW-2');
  t.mock.method(claudeCodeCli, 'removeWorktree', async () => {});
  t.mock.method(bitbucket, 'getPullRequest', async () => ({ id: 42, title: 'T', state: 'DECLINED' }) as any);
  assert.deepEqual(await watchDevCyclePr(c), { kind: 'declined' });
  assert.equal(getDevCycle(c.id)!.status, 'abandoned');

  const open = cycleWithPr('FBW-3');
  t.mock.method(bitbucket, 'getPullRequest', async () => ({ id: 42, title: 'T', state: 'OPEN' }) as any);
  t.mock.method(bitbucket, 'getPullRequestComments', async () => [comment({ commentId: 1, authorUsername: 'alice', text: 'Hm', createdDate: '2026-10-01T10:00:00Z' })]);
  const outcome = await watchDevCyclePr(open);
  assert.equal(outcome!.kind, 'open');
  assert.deepEqual((outcome as any).threads.map((th: any) => th.rootCommentId), [1]);
  assert.equal(getDevCycle(open.id)!.status, 'active');
});

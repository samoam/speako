import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle } from '../src/storage/devCycleRepository';
import { upsertFeedbackThreads, getFeedbackForCycle, getPendingFeedback, setFeedbackTriage, setFeedbackReply, markFeedbackAnswered } from '../src/storage/devCycleFeedbackRepository';

function cycle(key: string) {
  return createDevCycle({ ticketKey: key, repoName: 'r', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
}

const thread = (rootCommentId: number, text: string) => ({ rootCommentId, author: 'Reviewer', text, anchorPath: 'src/A.java', anchorLine: 12 });

test('upsertFeedbackThreads: inserts open rows keyed by root comment, and is idempotent for unchanged text', () => {
  const c = cycle('FB-1');
  upsertFeedbackThreads(c.id, [thread(100, 'please rename'), thread(101, 'why not null-check?')], 1);
  const again = upsertFeedbackThreads(c.id, [thread(100, 'please rename')], 1);
  assert.equal(again.length, 2);
  assert.deepEqual(again.map((f) => [f.rootCommentId, f.status, f.round, f.anchorPath, f.anchorLine]), [[100, 'open', 1, 'src/A.java', 12], [101, 'open', 1, 'src/A.java', 12]]);
});

test('triage → reply edit → answered: the row carries the decision, and a reviewer follow-up re-opens it with the new text', () => {
  const c = cycle('FB-2');
  const [row] = upsertFeedbackThreads(c.id, [thread(200, 'Reviewer: please rename')], 1);
  setFeedbackTriage(row.id, { action: 'change', reply: 'Will do.', changeInstruction: 'Rename foo to bar in A.java' });
  assert.deepEqual(getPendingFeedback(c.id).map((f) => [f.status, f.action, f.reply, f.changeInstruction]), [['triaged', 'change', 'Will do.', 'Rename foo to bar in A.java']]);

  setFeedbackReply(row.id, 'Renamed in the next push.');
  markFeedbackAnswered(row.id, 555, true);
  assert.equal(getPendingFeedback(c.id).length, 0, 'answered threads are no longer pending');
  const answered = getFeedbackForCycle(c.id)[0];
  assert.equal(answered.status, 'answered');
  assert.equal(answered.replyCommentId, 555);
  assert.equal(answered.resolved, true);
  assert.equal(answered.reply, 'Renamed in the next push.');
  assert.ok(answered.handledAt);

  // Same text again (e.g. the sync re-reading the PR before the reply landed) must not re-open it.
  upsertFeedbackThreads(c.id, [thread(200, 'Reviewer: please rename')], 2);
  assert.equal(getFeedbackForCycle(c.id)[0].status, 'answered');

  // The reviewer came back on the same thread: the row re-opens, the old decision is cleared, the round moves on.
  upsertFeedbackThreads(c.id, [thread(200, 'Reviewer: please rename\nme: Renamed in the next push.\nReviewer: also the getter')], 2);
  const reopened = getFeedbackForCycle(c.id);
  assert.equal(reopened.length, 1, 'still one row per thread');
  assert.deepEqual([reopened[0].status, reopened[0].round, reopened[0].action, reopened[0].reply, reopened[0].changeInstruction, reopened[0].handledAt], ['open', 2, null, null, null, null]);
  assert.match(reopened[0].text, /also the getter/);
});

test('feedback is scoped per cycle', () => {
  const a = cycle('FB-3');
  const b = cycle('FB-4');
  upsertFeedbackThreads(a.id, [thread(300, 'a')], 1);
  upsertFeedbackThreads(b.id, [thread(300, 'b')], 1);
  assert.deepEqual(getFeedbackForCycle(a.id).map((f) => f.text), ['a']);
  assert.deepEqual(getFeedbackForCycle(b.id).map((f) => f.text), ['b']);
});

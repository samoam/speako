import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle, setDevCycleBranch, setDevCyclePr } from '../src/storage/devCycleRepository';
import { upsertFeedbackThreads, setFeedbackTriage, getFeedbackForCycle } from '../src/storage/devCycleFeedbackRepository';
import { getRun, Run } from '../src/storage/runRepository';
import { setRunBroadcast, cancelRun } from '../src/orchestration/engine';
import { StepContext } from '../src/orchestration/types';
import { prFeedbackRunDefinition, PrFeedbackRunState, syncDevCyclePrFeedback, startPrFeedbackRun } from '../src/orchestration/kinds/prFeedbackRun';
import { getLatestDevCycleRun, devCycleRunSummary, isDevCycleAwaitingChangeApproval } from '../src/orchestration/kinds/devCycleRun';
import * as prFeedback from '../src/dev/prFeedback';
import * as bitbucket from '../src/integrations/bitbucketServer';

setRunBroadcast(() => {});

function cycleWithPr(key: string) {
  const c = createDevCycle({ ticketKey: key, repoName: 'r', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  setDevCycleBranch(c.id, { branchName: `feature/${key}-x`, worktreePath: 'C:\\wt' });
  setDevCyclePr(c.id, { projectKey: 'P', repoSlug: 'r', prId: 42, prUrl: 'https://bb/pr/42' });
  return getDevCycle(c.id)!;
}

function ctxFor(state: PrFeedbackRunState): StepContext<PrFeedbackRunState> & { logs: string[] } {
  const logs: string[] = [];
  return { runId: 0, state, log: (m) => logs.push(m), detail: () => {}, signal: new AbortController().signal, logs };
}

const thread = (rootCommentId: number, text: string) => ({ rootCommentId, author: 'Alice', text, anchorPath: null, anchorLine: null });

async function waitForStatus(runId: number, statuses: string[], timeoutMs = 5000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = getRun(runId)!;
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} still "${getRun(runId)!.status}" after ${timeoutMs}ms`);
}

test('feedback run: gather → triage → implement → [approve] apply_feedback → verify → push → post_replies → build', () => {
  const steps = prFeedbackRunDefinition.steps({ cycleId: 1, round: 1 }).flat();
  assert.deepEqual(steps.map((s) => s.key), ['gather_feedback', 'triage', 'implement_feedback', 'apply_feedback', 'verify_locally', 'push', 'post_replies', 'build_and_test']);
  assert.deepEqual(steps.filter((s) => s.approval).map((s) => s.key), ['apply_feedback'], 'replies and the change are approved together, once');
});

test('a round with no code change skips verify/push/build but still posts the replies', async (t) => {
  const c = cycleWithPr('PRF-1');
  const [row] = upsertFeedbackThreads(c.id, [thread(10, 'Alice: Why not a Set?')], 1);
  setFeedbackTriage(row.id, { action: 'answer', reply: 'Order matters here.', changeInstruction: null });
  const steps = prFeedbackRunDefinition.steps({ cycleId: c.id, round: 1 }).flat();
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  const state: PrFeedbackRunState = { cycleId: c.id, round: 1 };

  assert.match(String(await byKey.implement_feedback.run(ctxFor(state))), /replies only/);
  assert.match(String(await byKey.apply_feedback.run(ctxFor(state))), /No code change/);
  assert.match(String(await byKey.verify_locally.run(ctxFor(state))), /Skipped/);
  assert.match(String(await byKey.push.run(ctxFor(state))), /Skipped/);
  assert.match(String(await byKey.build_and_test.run(ctxFor(state))), /Skipped/);

  const posted: any[] = [];
  t.mock.method(bitbucket, 'addPullRequestComment', async (_ref: any, p: any) => {
    posted.push(p);
    return { id: 900 } as any;
  });
  const resolve = t.mock.method(bitbucket, 'resolvePullRequestComment', async () => true);
  assert.match(String(await byKey.post_replies.run(ctxFor(state))), /Replied to 1 thread/);
  assert.deepEqual(posted, [{ text: 'Order matters here.', parentId: 10 }]);
  assert.equal(resolve.mock.callCount(), 0, "an 'answer' leaves the thread open for the reviewer");
  const after = getFeedbackForCycle(c.id)[0];
  assert.deepEqual([after.status, after.replyCommentId, after.resolved], ['answered', 900, false]);
});

test("post_replies: a 'change' thread is resolved after the reply, and a resolve failure is logged, not fatal", async (t) => {
  const c = cycleWithPr('PRF-2');
  const rows = upsertFeedbackThreads(c.id, [thread(20, 'Alice: rename'), thread(21, 'Alice: null check')], 1);
  setFeedbackTriage(rows[0].id, { action: 'change', reply: 'Renamed.', changeInstruction: 'rename' });
  setFeedbackTriage(rows[1].id, { action: 'change', reply: 'Added.', changeInstruction: 'add' });
  t.mock.method(bitbucket, 'addPullRequestComment', async () => ({ id: 1 }) as any);
  t.mock.method(bitbucket, 'resolvePullRequestComment', async (_ref: any, id: number) => {
    if (id === 21) throw new Error('not a blocker');
    return true;
  });
  const step = prFeedbackRunDefinition.steps({ cycleId: c.id, round: 1 }).flat().find((s) => s.key === 'post_replies')!;
  const ctx = ctxFor({ cycleId: c.id, round: 1 });
  assert.match(String(await step.run(ctx)), /Replied to 2 thread\(s\), 1 resolved/);
  assert.ok(ctx.logs.some((l) => /Could not mark #\d+ resolved: not a blocker/.test(l)));
  assert.deepEqual(getFeedbackForCycle(c.id).map((f) => [f.status, f.resolved]), [['answered', true], ['answered', false]]);
});

test('syncDevCyclePrFeedback: starts a round for new reviewer threads, reports busy while a run is in flight, idle when nothing is new', async (t) => {
  const c = cycleWithPr('PRF-3');
  let threads = [thread(30, 'Alice: first')];
  // gather_feedback calls the same watcher; it then fails fast in triage because there is no worktree to read — enough to exercise the sync.
  t.mock.method(prFeedback, 'watchDevCyclePr', async () => ({ kind: 'open', threads }) as any);

  assert.equal(await syncDevCyclePrFeedback(c.id), 'started');
  const run = getLatestDevCycleRun(c.id)!;
  assert.equal(run.kind, 'pr_feedback');
  assert.equal((run.state as any).round, 1);
  assert.equal(getFeedbackForCycle(c.id).length, 1);

  assert.equal(await syncDevCyclePrFeedback(c.id), 'busy', 'a run in flight is left to finish');
  await cancelRun(run.id);
  await waitForStatus(run.id, ['cancelled', 'failed', 'done']);

  assert.equal(await syncDevCyclePrFeedback(c.id), 'idle', 'the same unanswered thread does not restart a round on every sync');

  threads = [thread(30, 'Alice: first'), thread(31, 'Alice: second')];
  assert.equal(await syncDevCyclePrFeedback(c.id), 'started', 'a new thread starts the next round');
  const second = getLatestDevCycleRun(c.id)!;
  assert.equal((second.state as any).round, 2);
  await cancelRun(second.id);
  await waitForStatus(second.id, ['cancelled', 'failed', 'done']);
});

test('syncDevCyclePrFeedback: a merged PR closes the cycle and is reported as such; a cycle without a PR is idle', async (t) => {
  const c = cycleWithPr('PRF-4');
  t.mock.method(prFeedback, 'watchDevCyclePr', async () => ({ kind: 'merged' }) as any);
  assert.equal(await syncDevCyclePrFeedback(c.id), 'merged');
  const noPr = createDevCycle({ ticketKey: 'PRF-5', repoName: 'r', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'In Progress' });
  assert.equal(await syncDevCyclePrFeedback(noPr.id), 'idle');
});

test('the feedback gate counts as a change approval for the Diff tab, and the summary carries the round', async (t) => {
  const c = cycleWithPr('PRF-6');
  t.mock.method(prFeedback, 'watchDevCyclePr', async () => ({ kind: 'open', threads: [] }) as any);
  const run = await startPrFeedbackRun(c.id);
  // No threads → gather, triage and implement all pass as no-ops → parked on the gate.
  await waitForStatus(run.id, ['waiting_approval', 'failed']);
  assert.equal(getRun(run.id)!.status, 'waiting_approval');
  assert.equal(devCycleRunSummary(c.id)!.awaitingGate, 'apply_feedback');
  assert.equal(devCycleRunSummary(c.id)!.feedbackRound, 1);
  assert.equal(isDevCycleAwaitingChangeApproval(c.id), true);
  await cancelRun(run.id);
});

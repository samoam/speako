import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/storage/db';
import { registerDraftKind } from '../src/drafts/registry';
import { DraftHandler } from '../src/drafts/types';
import {
  startDraft,
  refineDraft,
  editDraftContent,
  approveDraftGate,
  discardDraft,
  redoDraft,
  reconcileStuckDrafts,
  setDraftBroadcast,
  DraftConflictError,
} from '../src/drafts/draftService';
import { getDraft, getDraftRevisions } from '../src/storage/draftRepository';

/** A minimal in-memory subject store + fake kind for exercising the generic gate without any real integration. */
const subjects = new Map<string, { id: string; text: string }>();
const executed: { draftId: number; gateKey: string; content: any }[] = [];
const discarded: string[] = [];

function resetFixture() {
  subjects.clear();
  executed.length = 0;
  discarded.length = 0;
  subjects.set('1', { id: '1', text: 'hello' });
}

const singleGateKind: DraftHandler<{ id: string; text: string }> = {
  kind: 'test_single_gate',
  subjectKind: 'task',
  gates: [{ key: 'send', label: 'Send' }],
  redoStrategy: 'follow_up',
  loadSubject: (subjectId) => subjects.get(subjectId),
  async generate(input) {
    if (input.redo) return { mode: 'draft', content: { text: `follow-up: ${input.redo.observed}` } };
    if (input.instruction === 'ask why') return { mode: 'answer', text: 'because reasons' };
    if (input.instruction) return { mode: 'draft', content: { text: `${(input.priorContent as any)?.text}+${input.instruction}` } };
    return { mode: 'draft', content: { text: input.subject.text } };
  },
  async execute(gateKey, ctx) {
    executed.push({ draftId: ctx.draft.id, gateKey, content: ctx.content });
    return { ok: true };
  },
  async discard(ctx) {
    discarded.push(String(ctx.draft.id));
  },
  async observeSince() {
    return 'the recipient replied "thanks"';
  },
};

const twoGateKind: DraftHandler<{ id: string; text: string }> = {
  kind: 'test_two_gate',
  subjectKind: 'task',
  gates: [
    { key: 'commit', label: 'Commit' },
    { key: 'push', label: 'Push' },
  ],
  redoStrategy: 'fresh',
  loadSubject: (subjectId) => subjects.get(subjectId),
  async generate(input) {
    return { mode: 'draft', content: { text: input.subject.text } };
  },
  async execute(gateKey, ctx) {
    executed.push({ draftId: ctx.draft.id, gateKey, content: ctx.content });
    return { [gateKey]: true };
  },
};

const alwaysFailsKind: DraftHandler<{ id: string; text: string }> = {
  kind: 'test_always_fails',
  subjectKind: 'task',
  gates: [{ key: 'send', label: 'Send' }],
  redoStrategy: 'follow_up',
  loadSubject: (subjectId) => subjects.get(subjectId),
  async generate() {
    return { mode: 'draft', content: { text: 'x' } };
  },
  async execute() {
    throw new Error('execution boom');
  },
};

/** Always asks a clarifying question on first generation; any refine instruction resolves it into a real draft — exercises the 'awaiting_clarification' state end to end. */
const asksQuestionKind: DraftHandler<{ id: string; text: string }> = {
  kind: 'test_asks_question',
  subjectKind: 'task',
  gates: [{ key: 'send', label: 'Send' }],
  redoStrategy: 'follow_up',
  loadSubject: (subjectId) => subjects.get(subjectId),
  async generate(input) {
    if (input.instruction) return { mode: 'draft', content: { text: `resolved: ${input.instruction}` } };
    return { mode: 'question', text: 'Which option do you want?' };
  },
  async execute(gateKey, ctx) {
    executed.push({ draftId: ctx.draft.id, gateKey, content: ctx.content });
    return { ok: true };
  },
};

const noRefineKind: DraftHandler<{ id: string; text: string }> = {
  kind: 'test_no_refine',
  subjectKind: 'task',
  gates: [{ key: 'send', label: 'Send' }],
  redoStrategy: 'fresh',
  supportsRefine: false,
  loadSubject: (subjectId) => subjects.get(subjectId),
  async generate(input) {
    return { mode: 'draft', content: { text: input.subject.text } };
  },
  async execute() {
    return {};
  },
};

registerDraftKind(singleGateKind);
registerDraftKind(twoGateKind);
registerDraftKind(alwaysFailsKind);
registerDraftKind(asksQuestionKind);
registerDraftKind(noRefineKind);

// Avoid real WS broadcasting from a test process.
const broadcastEvents: any[] = [];
setDraftBroadcast((e) => broadcastEvents.push(e));

test('startDraft: generates the first draft synchronously enough to be ready right after (fake kind has no async delay)', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  // startDraft kicks off generation in the background — poll briefly for the fake (instant) generator to land.
  await new Promise((r) => setTimeout(r, 10));
  const updated = getDraft(draft.id)!;
  assert.equal(updated.status, 'ready');
  assert.deepEqual(updated.content, { text: 'hello' });
});

test('startDraft: unknown subject throws rather than creating a draft', async () => {
  resetFixture();
  await assert.rejects(() => startDraft({ kind: 'test_single_gate', subjectId: 999 }), DraftConflictError);
});

test('refineDraft: a revise instruction updates content and appends instruction+draft revisions', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const refined = await refineDraft(draft.id, 'make it shorter');
  assert.equal(refined.status, 'ready');
  assert.deepEqual(refined.content, { text: 'hello+make it shorter' });

  // revisions[0] is the initial-generation 'draft' revision from startDraft itself.
  const revisions = getDraftRevisions(draft.id);
  assert.equal(revisions.length, 3);
  assert.equal(revisions[1].kind, 'instruction');
  assert.equal(revisions[1].text, 'make it shorter');
  assert.equal(revisions[2].kind, 'draft');
});

test('refineDraft: an "answer" turn leaves content untouched and records an answer revision', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const answered = await refineDraft(draft.id, 'ask why');
  assert.equal(answered.status, 'ready');
  assert.deepEqual(answered.content, { text: 'hello' }); // unchanged

  const revisions = getDraftRevisions(draft.id);
  assert.equal(revisions[2].kind, 'answer');
  assert.equal(revisions[2].text, 'because reasons');
});

test('startDraft: a "question" result lands in awaiting_clarification and records a question revision', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_asks_question', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const updated = getDraft(draft.id)!;
  assert.equal(updated.status, 'awaiting_clarification');
  assert.equal(updated.content, null); // untouched, same as an 'answer' result

  const revisions = getDraftRevisions(draft.id);
  assert.equal(revisions[revisions.length - 1].kind, 'question');
  assert.equal(revisions[revisions.length - 1].text, 'Which option do you want?');
});

test('refineDraft: answering a pending clarifying question goes through the same path as any other instruction and resolves to ready', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_asks_question', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getDraft(draft.id)!.status, 'awaiting_clarification');

  const resolved = await refineDraft(draft.id, 'option B');
  assert.equal(resolved.status, 'ready');
  assert.deepEqual(resolved.content, { text: 'resolved: option B' });
});

test('discardDraft: can discard from awaiting_clarification', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_asks_question', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const result = await discardDraft(draft.id);
  assert.equal(result.status, 'discarded');
});

test('refineDraft: rejects a kind with supportsRefine === false', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_no_refine', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(() => refineDraft(draft.id, 'anything'), DraftConflictError);
});

test('editDraftContent: records a manual_edit revision and updates content directly', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const edited = editDraftContent(draft.id, { text: 'hand-edited' });
  assert.deepEqual(edited.content, { text: 'hand-edited' });
  const revisions = getDraftRevisions(draft.id);
  assert.equal(revisions[revisions.length - 1].kind, 'manual_edit');
});

test('approveDraftGate: a single-gate kind completes on first approval', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const approved = await approveDraftGate(draft.id);
  assert.equal(approved.status, 'completed');
  assert.deepEqual(approved.resultRef, { ok: true });
  assert.equal(executed[executed.length - 1].gateKey, 'send');
});

test('approveDraftGate: a two-gate kind requires two approvals, advancing stage between them', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_two_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const afterFirst = await approveDraftGate(draft.id);
  assert.equal(afterFirst.status, 'ready');
  assert.equal(afterFirst.stage, 1);
  assert.deepEqual(afterFirst.executionRef, { commit: true });

  const afterSecond = await approveDraftGate(draft.id);
  assert.equal(afterSecond.status, 'completed');
  assert.deepEqual(afterSecond.resultRef, { push: true });

  assert.deepEqual(
    executed.map((e) => e.gateKey),
    ['commit', 'push']
  );
});

test('approveDraftGate: rejects approving from a non-ready status (double-click guard)', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  await approveDraftGate(draft.id); // now 'completed'
  await assert.rejects(() => approveDraftGate(draft.id), DraftConflictError);
});

test('approveDraftGate: an executor that throws marks the draft failed, not stuck in "executing"', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_always_fails', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(() => approveDraftGate(draft.id), /execution boom/);
  const updated = getDraft(draft.id)!;
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'execution boom');
});

test('discardDraft: marks discarded and calls the handler\'s discard hook', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  const result = await discardDraft(draft.id);
  assert.equal(result.status, 'discarded');
  assert.ok(discarded.includes(String(draft.id)));
});

test('discardDraft: rejects discarding an already-completed draft', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));
  await approveDraftGate(draft.id);

  await assert.rejects(() => discardDraft(draft.id), DraftConflictError);
});

test('redoDraft: only valid from completed/failed, creates a new linked draft seeded with observeSince()', async () => {
  resetFixture();
  const draft = await startDraft({ kind: 'test_single_gate', subjectId: 1 });
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(() => redoDraft(draft.id), DraftConflictError); // still 'ready'

  const completed = await approveDraftGate(draft.id);
  assert.equal(completed.status, 'completed');

  const redo = await redoDraft(draft.id);
  assert.notEqual(redo.id, draft.id);
  assert.equal(redo.redoOfDraftId, draft.id);

  const originalAfterRedo = getDraft(draft.id)!;
  assert.equal(originalAfterRedo.supersededByDraftId, redo.id);
  assert.equal(originalAfterRedo.status, 'completed'); // never mutated

  await new Promise((r) => setTimeout(r, 10));
  const redoUpdated = getDraft(redo.id)!;
  assert.equal(redoUpdated.status, 'ready');
  assert.deepEqual(redoUpdated.content, { text: 'follow-up: the recipient replied "thanks"' });
});

test('reconcileStuckDrafts: marks generating/refining/executing rows failed with an explanatory error', async () => {
  resetFixture();
  // Simulate a row stuck mid-flight by never letting generation resolve before "restart".
  subjects.set('2', { id: '2', text: 'stuck' });
  const stuckDraftId = (await startDraft({ kind: 'test_single_gate', subjectId: 2 })).id;
  // Don't wait for generation — force it back to 'generating' to simulate a mid-flight row surviving a restart.
  db.prepare("UPDATE drafts SET status = 'generating' WHERE id = ?").run(stuckDraftId);

  await reconcileStuckDrafts();
  const reconciled = getDraft(stuckDraftId)!;
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.error!, /restarted/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraft,
  getDraft,
  getLatestDraftForSubject,
  getDraftsForSubject,
  getActiveDraftsByStatus,
  tryTransitionDraft,
  setDraftContent,
  setDraftError,
  setDraftExecutionRef,
  advanceDraftStage,
  completeDraft,
  discardDraft,
  supersedeDraft,
  appendDraftRevision,
  getDraftRevisions,
} from '../src/storage/draftRepository';

test('createDraft: defaults to status "generating", round-trips via getDraft', () => {
  const draft = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 1 });
  assert.equal(draft.status, 'generating');
  assert.equal(draft.stage, 0);
  assert.equal(draft.subjectId, '1');
  assert.equal(draft.content, null);
  assert.equal(draft.redoOfDraftId, null);
  assert.deepEqual(getDraft(draft.id), draft);
});

test('getLatestDraftForSubject: returns the most recent draft of a given kind for a subject', () => {
  const first = createDraft({ kind: 'jira_action', subjectKind: 'action_item', subjectId: 42 });
  const second = createDraft({ kind: 'jira_action', subjectKind: 'action_item', subjectId: 42 });
  // A different kind for the same subject must not interfere.
  createDraft({ kind: 'confluence_page', subjectKind: 'action_item', subjectId: 42 });

  const latest = getLatestDraftForSubject('action_item', 42, 'jira_action');
  assert.equal(latest?.id, second.id);
  assert.notEqual(latest?.id, first.id);
});

test('getDraftsForSubject: returns every draft (all kinds) for a subject in creation order', () => {
  const a = createDraft({ kind: 'bitbucket_pr_comment', subjectKind: 'pr_review_request', subjectId: 7 });
  const b = createDraft({ kind: 'bitbucket_pr_comment', subjectKind: 'pr_review_request', subjectId: 7 });
  const drafts = getDraftsForSubject('pr_review_request', 7);
  assert.deepEqual(
    drafts.map((d) => d.id),
    [a.id, b.id]
  );
});

test('tryTransitionDraft: succeeds from an allowed status and returns false from a disallowed one', () => {
  const draft = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 2 });
  setDraftContent(draft.id, { text: 'hi' }, { status: 'ready' });

  assert.equal(tryTransitionDraft(draft.id, ['ready'], 'refining'), true);
  assert.equal(getDraft(draft.id)?.status, 'refining');

  // Now the row is 'refining' — a second concurrent attempt to leave 'ready' must fail, not double-apply.
  assert.equal(tryTransitionDraft(draft.id, ['ready'], 'refining'), false);
});

test('setDraftContent: stores content as JSON and optionally updates status', () => {
  const draft = createDraft({ kind: 'confluence_page', subjectKind: 'session', subjectId: 's1' });
  setDraftContent(draft.id, { title: 'Design doc', body: 'text' }, { status: 'ready' });
  const updated = getDraft(draft.id)!;
  assert.deepEqual(updated.content, { title: 'Design doc', body: 'text' });
  assert.equal(updated.status, 'ready');
});

test('setDraftError: marks failed, sets error and resolvedAt', () => {
  const draft = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 3 });
  setDraftError(draft.id, 'Gemini call failed');
  const updated = getDraft(draft.id)!;
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'Gemini call failed');
  assert.ok(updated.resolvedAt);
});

test('setDraftExecutionRef / advanceDraftStage / completeDraft / discardDraft / supersedeDraft', () => {
  const draft = createDraft({ kind: 'code_change', subjectKind: 'task', subjectId: 4, executionRef: { table: 'code_change_requests', id: 1 } });
  assert.deepEqual(draft.executionRef, { table: 'code_change_requests', id: 1 });

  setDraftExecutionRef(draft.id, { table: 'code_change_requests', id: 2 });
  assert.deepEqual(getDraft(draft.id)?.executionRef, { table: 'code_change_requests', id: 2 });

  advanceDraftStage(draft.id);
  const afterAdvance = getDraft(draft.id)!;
  assert.equal(afterAdvance.stage, 1);
  assert.equal(afterAdvance.status, 'ready');

  completeDraft(draft.id, { commitSha: 'abc123' });
  const completed = getDraft(draft.id)!;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.resultRef, { commitSha: 'abc123' });
  assert.ok(completed.resolvedAt);

  const redo = createDraft({ kind: 'code_change', subjectKind: 'task', subjectId: 4, redoOfDraftId: draft.id });
  supersedeDraft(draft.id, redo.id);
  assert.equal(getDraft(draft.id)?.supersededByDraftId, redo.id);
  assert.equal(getDraft(redo.id)?.redoOfDraftId, draft.id);

  const other = createDraft({ kind: 'email_reply', subjectKind: 'task', subjectId: 5 });
  discardDraft(other.id);
  const discarded = getDraft(other.id)!;
  assert.equal(discarded.status, 'discarded');
  assert.ok(discarded.resolvedAt);
});

test('getActiveDraftsByStatus: filters across multiple statuses, used for startup reconciliation', () => {
  const generating = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 10 });
  const ready = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 11 });
  setDraftContent(ready.id, {}, { status: 'ready' });
  const completed = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 12 });
  completeDraft(completed.id, {});

  const active = getActiveDraftsByStatus(['generating', 'ready']);
  const activeIds = active.map((d) => d.id);
  assert.ok(activeIds.includes(generating.id));
  assert.ok(activeIds.includes(ready.id));
  assert.ok(!activeIds.includes(completed.id));
});

test('appendDraftRevision: numbers turns sequentially per draft, round-trips role/kind/text/content', () => {
  const draft = createDraft({ kind: 'teams_reply', subjectKind: 'task', subjectId: 20 });
  const first = appendDraftRevision({ draftId: draft.id, role: 'user', kind: 'instruction', text: 'make it shorter' });
  const second = appendDraftRevision({ draftId: draft.id, role: 'assistant', kind: 'draft', text: 'Trimmed.', content: { text: 'Trimmed reply' } });
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 2);

  const revisions = getDraftRevisions(draft.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].role, 'user');
  assert.equal(revisions[0].text, 'make it shorter');
  assert.equal(revisions[1].role, 'assistant');
  assert.deepEqual(revisions[1].content, { text: 'Trimmed reply' });
});

test('appendDraftRevision: truncates oversized content rather than storing it whole', () => {
  const draft = createDraft({ kind: 'code_change', subjectKind: 'task', subjectId: 21 });
  const bigDiff = 'x'.repeat(200_000);
  const revision = appendDraftRevision({ draftId: draft.id, role: 'assistant', kind: 'draft', content: { diff: bigDiff } });
  assert.equal(revision.content.truncated, true);
  assert.ok(revision.content.bytes > 64 * 1024);
});

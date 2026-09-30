import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask, getOpenTasks, getTaskById } from '../src/storage/taskRepository';
import { createPrReviewRequest, markPrReviewReady } from '../src/storage/prReviewRequestRepository';
import * as bitbucketServerModule from '../src/integrations/bitbucketServer';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { prReviewDecisionDraft } from '../src/drafts/kinds/prReviewDecisionDraft';

function mockGemini(fake: unknown) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
}

function seedReviewRequest(externalRef: string, recommendation: 'approve' | 'request_changes' | 'comment', findings: any[] = []) {
  upsertTask({ source: 'bitbucket_pr', externalRef, title: 'Add caching', urgencyScore: 3, importanceScore: 3 });
  const taskId = getOpenTasks().find((t) => t.externalRef === externalRef)!.id;
  const request = createPrReviewRequest({ taskId, repoName: 'officercc', branchName: 'feature/caching' });
  markPrReviewReady(request.id, { summary: 'Looks good overall.', recommendation, findings });
  return request.id;
}

test('prReviewDecisionDraft.loadSubject: resolves the PR ref from the task\'s externalRef', async () => {
  const requestId = seedReviewRequest('PROJ/repo#42', 'approve');
  const subject = await prReviewDecisionDraft.loadSubject(String(requestId));
  assert.equal(subject?.pr.projectKey, 'PROJ');
  assert.equal(subject?.pr.repoSlug, 'repo');
  assert.equal(subject?.pr.id, 42);
});

test('prReviewDecisionDraft.loadSubject: undefined for an unknown request id', async () => {
  assert.equal(await prReviewDecisionDraft.loadSubject('999999'), undefined);
});

test('prReviewDecisionDraft.loadSubject: undefined for a non-numeric subjectId', async () => {
  assert.equal(await prReviewDecisionDraft.loadSubject('not-a-number'), undefined);
});

test('prReviewDecisionDraft.generate: first generation maps recommendation "approve" to status APPROVED', async () => {
  const requestId = seedReviewRequest('PROJ/repo#43', 'approve');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;
  const result = await prReviewDecisionDraft.generate({ draftId: 1, subject, history: [] });
  assert.equal(result.mode, 'draft');
  assert.equal((result as any).content.status, 'APPROVED');
  assert.equal((result as any).content.text, 'Looks good overall.');
});

test('prReviewDecisionDraft.generate: first generation maps recommendation "request_changes" to status NEEDS_WORK', async () => {
  const requestId = seedReviewRequest('PROJ/repo#44', 'request_changes');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;
  const result = await prReviewDecisionDraft.generate({ draftId: 1, subject, history: [] });
  assert.equal((result as any).content.status, 'NEEDS_WORK');
});

test('prReviewDecisionDraft.generate: first generation maps recommendation "comment" to status UNAPPROVED', async () => {
  const requestId = seedReviewRequest('PROJ/repo#45', 'comment');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;
  const result = await prReviewDecisionDraft.generate({ draftId: 1, subject, history: [] });
  assert.equal((result as any).content.status, 'UNAPPROVED');
});

test('prReviewDecisionDraft.generate: a refine instruction updates only the text, not the status', async () => {
  const requestId = seedReviewRequest('PROJ/repo#46', 'request_changes');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;

  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ action: 'revise', draftText: 'Please address the findings before merging.', note: 'made it more specific' });
  try {
    const result = await prReviewDecisionDraft.generate({
      draftId: 1,
      subject,
      priorContent: { status: 'NEEDS_WORK', text: 'old text' },
      history: [],
      instruction: 'be more specific',
    });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.text, 'Please address the findings before merging.');
    assert.equal((result as any).content.status, 'NEEDS_WORK'); // untouched by the refine
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('prReviewDecisionDraft.generate: a refine question answers without changing the draft', async () => {
  const requestId = seedReviewRequest('PROJ/repo#47', 'approve');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;

  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ action: 'answer', answer: 'Because the diff only touches tests.' });
  try {
    const result = await prReviewDecisionDraft.generate({
      draftId: 1,
      subject,
      priorContent: { status: 'APPROVED', text: 'Looks good.' },
      history: [],
      instruction: 'why approve?',
    });
    assert.equal(result.mode, 'answer');
    assert.equal((result as any).text, 'Because the diff only touches tests.');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('prReviewDecisionDraft.execute: posts a comment and sets the participant status', async () => {
  const requestId = seedReviewRequest('PROJ/repo#48', 'request_changes');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;

  const commentSpy = mock.method(bitbucketServerModule, 'addPullRequestComment', async (pr: any, input: any) => {
    assert.equal(pr.id, 48);
    assert.equal(input.text, 'Please fix the null check.');
    return { id: 555, version: 0 };
  });
  const statusSpy = mock.method(bitbucketServerModule, 'setPullRequestParticipantStatus', async (pr: any, status: any) => {
    assert.equal(pr.id, 48);
    assert.equal(status, 'NEEDS_WORK');
  });
  try {
    const result = await prReviewDecisionDraft.execute('post', {
      draft: {} as any,
      subject,
      content: { status: 'NEEDS_WORK', text: 'Please fix the null check.' },
    });
    assert.equal((result as any).status, 'NEEDS_WORK');
    assert.equal((result as any).commentId, 555);
    assert.equal(commentSpy.mock.callCount(), 1);
    assert.equal(statusSpy.mock.callCount(), 1);
  } finally {
    commentSpy.mock.restore();
    statusSpy.mock.restore();
  }
});

test('prReviewDecisionDraft.execute: skips posting a comment when text is empty, but still sets status', async () => {
  const requestId = seedReviewRequest('PROJ/repo#49', 'approve');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;

  const commentSpy = mock.method(bitbucketServerModule, 'addPullRequestComment', async () => {
    throw new Error('should not be called');
  });
  const statusSpy = mock.method(bitbucketServerModule, 'setPullRequestParticipantStatus', async () => {});
  try {
    const result = await prReviewDecisionDraft.execute('post', {
      draft: {} as any,
      subject,
      content: { status: 'APPROVED', text: '   ' },
    });
    assert.equal((result as any).status, 'APPROVED');
    assert.equal((result as any).commentId, undefined);
    assert.equal(commentSpy.mock.callCount(), 0);
    assert.equal(statusSpy.mock.callCount(), 1);
  } finally {
    commentSpy.mock.restore();
    statusSpy.mock.restore();
  }
});

test('prReviewDecisionDraft.execute: dismisses the underlying task immediately on APPROVED', async () => {
  // The task can never be pruned by the periodic Bitbucket sync (its
  // pr_review_requests row protects it from pruneTasksForSource's hard
  // delete) — so approving here must dismiss it directly rather than
  // waiting for that sync to catch up.
  const requestId = seedReviewRequest('PROJ/repo#50', 'approve');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;

  const statusSpy = mock.method(bitbucketServerModule, 'setPullRequestParticipantStatus', async () => {});
  try {
    await prReviewDecisionDraft.execute('post', {
      draft: {} as any,
      subject,
      content: { status: 'APPROVED', text: '' },
    });
    assert.equal(getTaskById(subject.request.taskId)?.status, 'dismissed');
  } finally {
    statusSpy.mock.restore();
  }
});

test('prReviewDecisionDraft.execute: does not dismiss the task for NEEDS_WORK or UNAPPROVED', async () => {
  const requestId = seedReviewRequest('PROJ/repo#51', 'request_changes');
  const subject = (await prReviewDecisionDraft.loadSubject(String(requestId)))!;

  const statusSpy = mock.method(bitbucketServerModule, 'setPullRequestParticipantStatus', async () => {});
  try {
    await prReviewDecisionDraft.execute('post', {
      draft: {} as any,
      subject,
      content: { status: 'NEEDS_WORK', text: '' },
    });
    assert.equal(getTaskById(subject.request.taskId)?.status, 'open');
  } finally {
    statusSpy.mock.restore();
  }
});

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask, getOpenTasks } from '../src/storage/taskRepository';
import { createPrReviewRequest, markPrReviewReady } from '../src/storage/prReviewRequestRepository';
import * as bitbucketServerModule from '../src/integrations/bitbucketServer';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { bitbucketPrCommentDraft, prCommentSubjectId } from '../src/drafts/kinds/bitbucketPrCommentDraft';

function mockGemini(fake: unknown) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
}

function seedReviewRequest(externalRef: string, findings: any[]) {
  upsertTask({ source: 'bitbucket_pr', externalRef, title: 'Add caching', urgencyScore: 3, importanceScore: 3 });
  const taskId = getOpenTasks().find((t) => t.externalRef === externalRef)!.id;
  const request = createPrReviewRequest({ taskId, repoName: 'officercc', branchName: 'feature/caching' });
  markPrReviewReady(request.id, { summary: 's', recommendation: 'comment', findings });
  return request.id;
}

test('bitbucketPrCommentDraft.loadSubject: parses the composite id and resolves the PR ref from the task\'s externalRef', async () => {
  const requestId = seedReviewRequest('PROJ/repo#42', [{ file: 'src/foo.ts', line: 12, severity: 'major', comment: 'x' }]);
  const subject = await bitbucketPrCommentDraft.loadSubject(prCommentSubjectId(requestId, 0));
  assert.equal(subject?.pr.projectKey, 'PROJ');
  assert.equal(subject?.pr.repoSlug, 'repo');
  assert.equal(subject?.pr.id, 42);
  assert.equal(subject?.finding.file, 'src/foo.ts');
});

test('bitbucketPrCommentDraft.loadSubject: undefined for an out-of-range finding index', async () => {
  const requestId = seedReviewRequest('PROJ/repo#43', [{ file: 'src/foo.ts', line: 12, severity: 'major', comment: 'x' }]);
  assert.equal(await bitbucketPrCommentDraft.loadSubject(prCommentSubjectId(requestId, 5)), undefined);
});

test('bitbucketPrCommentDraft.loadSubject: undefined for a malformed subjectId', async () => {
  assert.equal(await bitbucketPrCommentDraft.loadSubject('not-valid'), undefined);
});

test('bitbucketPrCommentDraft.generate: first generation resolves an inline anchor from a fresh diff fetch', async () => {
  const requestId = seedReviewRequest('PROJ/repo#44', [{ file: 'src/foo.ts', line: 12, severity: 'blocker', comment: 'fix this' }]);
  const subject = (await bitbucketPrCommentDraft.loadSubject(prCommentSubjectId(requestId, 0)))!;

  const pathsSpy = mock.method(bitbucketServerModule, 'getPullRequestChangedPaths', async () => ['src/foo.ts']);
  const anchorsSpy = mock.method(bitbucketServerModule, 'getPullRequestDiffAnchors', async () => [{ line: 12, lineType: 'ADDED', fileType: 'TO' }]);
  try {
    const result = await bitbucketPrCommentDraft.generate({ draftId: 1, subject, history: [] });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.mode, 'inline');
    assert.match((result as any).content.text, /fix this/);
  } finally {
    pathsSpy.mock.restore();
    anchorsSpy.mock.restore();
  }
});

test('bitbucketPrCommentDraft.generate: a redo drafts a retraction referencing the original finding', async () => {
  const requestId = seedReviewRequest('PROJ/repo#45', [{ file: 'src/foo.ts', line: 12, severity: 'blocker', comment: 'fix this' }]);
  const subject = (await bitbucketPrCommentDraft.loadSubject(prCommentSubjectId(requestId, 0)))!;

  const result = await bitbucketPrCommentDraft.generate({
    draftId: 1,
    subject,
    history: [],
    redo: {
      priorContent: { text: 'old text', mode: 'inline', anchor: null, anchorWarning: null },
      priorResultRef: { commentId: 1, version: 0 },
      priorHistory: [],
      observed: '',
      strategy: 'follow_up',
      instruction: 'this was a false positive',
    },
  });
  assert.equal(result.mode, 'draft');
  assert.match((result as any).content.text, /Retracting my earlier comment/);
  assert.match((result as any).content.text, /false positive/);
  assert.equal((result as any).content.mode, 'general');
});

test('bitbucketPrCommentDraft.generate: a refine instruction updates the text via the answer/revise envelope', async () => {
  const requestId = seedReviewRequest('PROJ/repo#46', [{ file: 'src/foo.ts', line: 12, severity: 'blocker', comment: 'fix this' }]);
  const subject = (await bitbucketPrCommentDraft.loadSubject(prCommentSubjectId(requestId, 0)))!;

  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ action: 'revise', draftText: 'softer wording', note: 'softened tone' });
  try {
    const result = await bitbucketPrCommentDraft.generate({
      draftId: 1,
      subject,
      priorContent: { text: 'harsh wording', mode: 'inline', anchor: null, anchorWarning: null },
      history: [],
      instruction: 'soften this',
    });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.text, 'softer wording');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('bitbucketPrCommentDraft.execute: posts the comment with its anchor and returns the comment ref', async () => {
  const requestId = seedReviewRequest('PROJ/repo#47', [{ file: 'src/foo.ts', line: 12, severity: 'blocker', comment: 'fix this' }]);
  const subject = (await bitbucketPrCommentDraft.loadSubject(prCommentSubjectId(requestId, 0)))!;

  const postSpy = mock.method(bitbucketServerModule, 'addPullRequestComment', async (pr: any, input: any) => {
    assert.equal(pr.id, 47);
    assert.equal(input.text, 'the comment text');
    assert.deepEqual(input.anchor, { path: 'src/foo.ts', line: 12, lineType: 'ADDED', fileType: 'TO', diffType: 'EFFECTIVE' });
    return { id: 999, version: 0 };
  });
  try {
    const result = await bitbucketPrCommentDraft.execute('post', {
      draft: {} as any,
      subject,
      content: { text: 'the comment text', mode: 'inline', anchor: { path: 'src/foo.ts', line: 12, lineType: 'ADDED', fileType: 'TO', diffType: 'EFFECTIVE' }, anchorWarning: null },
    });
    assert.equal((result as any).commentId, 999);
    assert.equal(postSpy.mock.callCount(), 1);
  } finally {
    postSpy.mock.restore();
  }
});

test('bitbucketPrCommentDraft.legacyBroadcast: fires pr-comment-drafts-updated for the review request', () => {
  const events = bitbucketPrCommentDraft.legacyBroadcast!({ subjectId: '7:0' } as any, 'completed');
  assert.deepEqual(events, [{ type: 'pr-comment-drafts-updated', prReviewRequestId: 7 }]);
});

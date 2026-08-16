import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDevCycle, getDevCycle } from '../src/storage/devCycleRepository';
import * as jiraTransitionsModule from '../src/integrations/jiraTransitions';
import { jiraTransitionDraft, lifecycleTransitionSubjectId } from '../src/drafts/kinds/jiraTransitionDraft';

function seedCycle(ticketKey: string) {
  return createDevCycle({ ticketKey, repoName: 'officercc', repoPath: 'C:\\repo', branchType: 'feature', lifecycleState: 'Dev Ready' });
}

test('lifecycleTransitionSubjectId: encodes devCycleId and targetState', () => {
  assert.equal(lifecycleTransitionSubjectId(42, 'In Progress'), '42:In Progress');
});

test('jiraTransitionDraft.loadSubject: parses the composite subjectId back into {cycle, targetState}', async () => {
  const cycle = seedCycle('PROJ-1');
  const subject = await jiraTransitionDraft.loadSubject(lifecycleTransitionSubjectId(cycle.id, 'In Progress'));
  assert.equal(subject?.cycle.id, cycle.id);
  assert.equal(subject?.targetState, 'In Progress');
});

test('jiraTransitionDraft.loadSubject: undefined for a malformed or unknown-cycle subjectId', async () => {
  assert.equal(await jiraTransitionDraft.loadSubject('not-a-valid-id'), undefined);
  assert.equal(await jiraTransitionDraft.loadSubject('999999:In Progress'), undefined);
});

test('jiraTransitionDraft.generate: drafts the transition when the live status supports it', async () => {
  const cycle = seedCycle('PROJ-2');
  const spy = mock.method(jiraTransitionsModule, 'getCurrentLifecycleState', async () => 'Dev Ready' as const);
  try {
    const result = await jiraTransitionDraft.generate({ draftId: 1, subject: { cycle, targetState: 'In Progress' }, history: [] });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.toState, 'In Progress');
  } finally {
    spy.mock.restore();
  }
});

test('jiraTransitionDraft.generate: throws rather than drafting an invalid transition (e.g. ticket already moved on)', async () => {
  const cycle = seedCycle('PROJ-3');
  const spy = mock.method(jiraTransitionsModule, 'getCurrentLifecycleState', async () => 'Release' as const);
  try {
    await assert.rejects(
      () => jiraTransitionDraft.generate({ draftId: 1, subject: { cycle, targetState: 'In Progress' }, history: [] }),
      /not a valid transition/
    );
  } finally {
    spy.mock.restore();
  }
});

test('jiraTransitionDraft.generate: a refine instruction only changes the comment, never the target state', async () => {
  const cycle = seedCycle('PROJ-4');
  const result = await jiraTransitionDraft.generate({
    draftId: 1,
    subject: { cycle, targetState: 'QA Ready' },
    priorContent: { toState: 'QA Ready', comment: 'old comment' },
    history: [],
    instruction: 'mention the workaround',
  });
  assert.equal((result as any).content.toState, 'QA Ready');
  assert.equal((result as any).content.comment, 'mention the workaround');
});

test('jiraTransitionDraft.execute: re-validates live status before writing, and applies the resolved transition', async () => {
  const cycle = seedCycle('PROJ-5');
  const stateSpy = mock.method(jiraTransitionsModule, 'getCurrentLifecycleState', async () => 'Dev Ready' as const);
  const resolveSpy = mock.method(jiraTransitionsModule, 'resolveTransition', async (_key: string, target: string) => {
    assert.equal(target, 'In Progress');
    return { id: '21', name: 'Start Progress', toStatusName: 'In Progress' };
  });
  const transitionSpy = mock.method(jiraTransitionsModule, 'transitionIssue', async () => {});
  try {
    const result = await jiraTransitionDraft.execute('transition', {
      draft: {} as any,
      subject: { cycle, targetState: 'In Progress' },
      content: { toState: 'In Progress', comment: 'Starting work.' },
    });
    assert.equal((result as any).transitionId, '21');
    assert.equal(transitionSpy.mock.callCount(), 1);
    assert.deepEqual(transitionSpy.mock.calls[0].arguments, ['PROJ-5', '21', 'Starting work.']);

    const updated = getDevCycle(cycle.id)!;
    assert.equal(updated.lifecycleState, 'In Progress');
  } finally {
    stateSpy.mock.restore();
    resolveSpy.mock.restore();
    transitionSpy.mock.restore();
  }
});

test('jiraTransitionDraft.execute: refuses to apply a transition the live ticket no longer supports (staleness guard)', async () => {
  const cycle = seedCycle('PROJ-6');
  const spy = mock.method(jiraTransitionsModule, 'getCurrentLifecycleState', async () => 'QA Ready' as const);
  try {
    await assert.rejects(
      () =>
        jiraTransitionDraft.execute('transition', {
          draft: {} as any,
          subject: { cycle, targetState: 'In Progress' },
          content: { toState: 'In Progress', comment: 'x' },
        }),
      /not a valid transition/
    );
  } finally {
    spy.mock.restore();
  }
});

test('jiraTransitionDraft.execute: bumps the dev cycle round when a Return -> In Progress transition is applied', async () => {
  const cycle = seedCycle('PROJ-7');
  assert.equal(cycle.round, 1);
  const stateSpy = mock.method(jiraTransitionsModule, 'getCurrentLifecycleState', async () => 'Return' as const);
  const resolveSpy = mock.method(jiraTransitionsModule, 'resolveTransition', async () => ({ id: '31', name: 'Reopen', toStatusName: 'In Progress' }));
  const transitionSpy = mock.method(jiraTransitionsModule, 'transitionIssue', async () => {});
  try {
    await jiraTransitionDraft.execute('transition', {
      draft: {} as any,
      subject: { cycle, targetState: 'In Progress' },
      content: { toState: 'In Progress', comment: 'Back in progress.' },
    });
    assert.equal(getDevCycle(cycle.id)!.round, 2);
  } finally {
    stateSpy.mock.restore();
    resolveSpy.mock.restore();
    transitionSpy.mock.restore();
  }
});

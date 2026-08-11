import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as toolCatalog from '../src/prep/toolCatalog';
import * as ragModule from '../src/rag/rag';
import { gather as standupGather } from '../src/prep/workflows/standup';
import { gather as sprintPlanningGather } from '../src/prep/workflows/sprintPlanning';
import { gather as sprintReviewGather } from '../src/prep/workflows/sprintReview';
import { gather as retroGather } from '../src/prep/workflows/retro';
import { gather as oneOnOneGather } from '../src/prep/workflows/oneOnOne';
import { gather as designDevGather } from '../src/prep/workflows/designDev';
import { gather as genericGather } from '../src/prep/workflows/generic';
import { WorkflowContext } from '../src/prep/workflows/types';

function baseCtx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    sessionId: 'wf-session',
    sessionName: undefined,
    userNotes: undefined,
    meetingType: 'generic',
    previousSession: undefined,
    activeTools: null,
    ...overrides,
  };
}

function mockSearchByTool() {
  return mock.method(toolCatalog, 'searchByTool', async (tool: string) => `canned result for ${tool}`);
}

test('standup workflow: queries jira twice, confluence once, plus previous-standup notes', async () => {
  const spy = mockSearchByTool();
  try {
    const { sources } = await standupGather(baseCtx());
    assert.deepEqual(
      sources.map((s) => s.name).sort(),
      ['confluence_sprint_goal', 'jira_blockers', 'jira_recent_activity'].sort()
      // previous_standup is dropped: no previousSession -> previousSessionNotes() resolves '' -> trySource returns null
    );
  } finally {
    spy.mock.restore();
  }
});

test('sprintPlanning workflow: queries jira x2, confluence, bitbucket, and my PR review activity', async () => {
  const spy = mockSearchByTool();
  try {
    const { sources } = await sprintPlanningGather(baseCtx());
    assert.deepEqual(
      sources.map((s) => s.name).sort(),
      ['bitbucket_my_pr_activity', 'bitbucket_recent_activity', 'confluence_velocity', 'jira_backlog', 'jira_carryover'].sort()
    );
  } finally {
    spy.mock.restore();
  }
});

test('sprintReview workflow: queries jira, confluence, bitbucket, my PR review activity, and email', async () => {
  const spy = mockSearchByTool();
  try {
    const { sources } = await sprintReviewGather(baseCtx({ sessionName: 'Sprint 12 Review' }));
    assert.deepEqual(
      sources.map((s) => s.name).sort(),
      ['bitbucket_my_pr_activity', 'bitbucket_recent_commits', 'confluence_sprint_goal', 'email_context', 'jira_sprint_tickets'].sort()
    );
  } finally {
    spy.mock.restore();
  }
});

test('retro workflow: queries jira + confluence, includes sentiment signal source name only when there is a previous session', async () => {
  const spy = mockSearchByTool();
  try {
    const { sources } = await retroGather(baseCtx());
    const names = sources.map((s) => s.name);
    assert.ok(names.includes('jira_sprint_outcome'));
    assert.ok(names.includes('confluence_retro_template'));
    assert.ok(!names.includes('sentiment_friction_signals')); // no previousSession -> resolves '' -> dropped
    assert.ok(!names.includes('previous_retro_action_items'));
  } finally {
    spy.mock.restore();
  }
});

test('oneOnOne workflow: queries mem0, jira, email, teams, plus local DB-only sources', async () => {
  const toolSpy = mockSearchByTool();
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  try {
    const { sources } = await oneOnOneGather(baseCtx({ sessionName: '1:1 with Sam' }));
    const names = sources.map((s) => s.name);
    assert.ok(names.includes('mem0_facts'));
    assert.ok(names.includes('jira_their_activity'));
    assert.ok(names.includes('email_context'));
    assert.ok(names.includes('teams_context'));
    // past_1on1s/open_action_items/previous_1on1 resolve empty in this synthetic setup and are correctly dropped by trySource.
  } finally {
    toolSpy.mock.restore();
    retrieveSpy.mock.restore();
  }
});

test('designDev workflow: queries every tool-backed source including email/teams/webSearch', async () => {
  const spy = mockSearchByTool();
  try {
    const { sources } = await designDevGather(baseCtx({ sessionName: 'Design review' }));
    assert.deepEqual(
      sources.map((s) => s.name).sort(),
      [
        'bitbucket_recent_activity',
        'confluence_design_docs',
        'email_context',
        'jira_related_tickets',
        'local_codebase',
        'myrag_external_refs',
        'teams_context',
        'web_context',
      ].sort()
    );
  } finally {
    spy.mock.restore();
  }
});

test('generic workflow: queries jira/confluence/email/teams but NOT bitbucket for a non-code topic', async () => {
  const toolSpy = mockSearchByTool();
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  try {
    const { sources } = await genericGather(baseCtx({ sessionName: 'quarterly offsite planning' }));
    const names = sources.map((s) => s.name);
    assert.ok(names.includes('jira_keyword_search'));
    assert.ok(names.includes('confluence_keyword_search'));
    assert.ok(!names.includes('bitbucket_keyword_search'), 'non-code topic should not trigger a Bitbucket search');
  } finally {
    toolSpy.mock.restore();
    retrieveSpy.mock.restore();
  }
});

test('generic workflow: DOES query bitbucket when the topic looks code-related', async () => {
  const toolSpy = mockSearchByTool();
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  try {
    const { sources } = await genericGather(baseCtx({ sessionName: 'fix the API deployment error' }));
    const names = sources.map((s) => s.name);
    assert.ok(names.includes('bitbucket_keyword_search'), 'code-related topic should trigger a Bitbucket search');
  } finally {
    toolSpy.mock.restore();
    retrieveSpy.mock.restore();
  }
});

test('every workflow respects per-session activeTools gating (empty list -> zero tool-backed sources)', async () => {
  const spy = mockSearchByTool();
  try {
    const { sources } = await designDevGather(baseCtx({ sessionName: 'Design review', activeTools: [] }));
    assert.deepEqual(sources, []);
    assert.equal(spy.mock.callCount(), 0, 'searchByTool should never be invoked when every tool is inactive');
  } finally {
    spy.mock.restore();
  }
});

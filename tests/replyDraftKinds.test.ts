import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask, getOpenTasks } from '../src/storage/taskRepository';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import * as replyContextGatheringModule from '../src/drafts/kinds/replyContextGathering';
import { teamsReplyDraft } from '../src/drafts/kinds/teamsReplyDraft';
import { emailReplyDraft } from '../src/drafts/kinds/emailReplyDraft';

function seedTask(source: 'teams_message' | 'email_message', externalRef: string, draftReply: string | null): number {
  upsertTask({ source, externalRef, title: 'A message', urgencyScore: 3, importanceScore: 3, draftReply });
  return getOpenTasks().find((t) => t.source === source && t.externalRef === externalRef)!.id;
}

function mockGemini(fake: unknown) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
}

/** Avoids real Jira/Confluence/mem0/etc. network calls — gatherReplyContext's own logic (tool gating, formatting) is out of scope for these tests, which cover generateReplyDraft's draft/clarify/answer/loop-cap decision. */
function mockGatherReplyContext(fixedContext = 'fake gathered context') {
  return mock.method(replyContextGatheringModule, 'gatherReplyContext', async () => fixedContext);
}

test('teamsReplyDraft.loadSubject: only resolves a task whose source is teams_message', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#1', 'hey there');
  const emailId = seedTask('email_message', 'reply-kinds-test/email#1', 'hi');

  assert.equal((await teamsReplyDraft.loadSubject(String(teamsId)))?.id, teamsId);
  assert.equal(await teamsReplyDraft.loadSubject(String(emailId)), undefined);
  assert.equal(await teamsReplyDraft.loadSubject('999999'), undefined);
});

test('emailReplyDraft.loadSubject: only resolves a task whose source is email_message', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#2', 'hey there');
  const emailId = seedTask('email_message', 'reply-kinds-test/email#2', 'hi');

  assert.equal((await emailReplyDraft.loadSubject(String(emailId)))?.id, emailId);
  assert.equal(await emailReplyDraft.loadSubject(String(teamsId)), undefined);
});

test('teamsReplyDraft.generate: first generation seeds straight from the task\'s draft_reply, no Gemini call needed', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#3', 'Sounds good, will do.');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const result = await teamsReplyDraft.generate({ draftId: 1, subject: task, history: [] });
  assert.deepEqual(result, { mode: 'draft', content: { text: 'Sounds good, will do.' } });
});

test('emailReplyDraft.generate: first generation seeds straight from the task\'s draft_reply', async () => {
  const emailId = seedTask('email_message', 'reply-kinds-test/email#3', 'Thanks, following up shortly.');
  const task = (await emailReplyDraft.loadSubject(String(emailId)))!;
  const result = await emailReplyDraft.generate({ draftId: 1, subject: task, history: [] });
  assert.deepEqual(result, { mode: 'draft', content: { text: 'Thanks, following up shortly.' } });
});

test('teamsReplyDraft.generate: a refine instruction throws when Gemini is not configured (test env has no GEMINI_API_KEY)', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#4', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  await assert.rejects(
    () => teamsReplyDraft.generate({ draftId: 1, subject: task, priorContent: { text: 'ok' }, history: [], instruction: 'make it shorter' }),
    /GEMINI_API_KEY/
  );
});

test('teamsReplyDraft.generate: a redo with no Gemini configured falls back to the prior text rather than throwing', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#5', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const result = await teamsReplyDraft.generate({
    draftId: 1,
    subject: task,
    history: [],
    redo: { priorContent: { text: 'original reply' }, priorResultRef: {}, priorHistory: [], observed: 'they replied "thanks"', strategy: 'follow_up' },
  });
  assert.deepEqual(result, { mode: 'draft', content: { text: 'original reply' } });
});

test('teamsReplyDraft.execute: records the approved text with a timestamp, marked manual (no real send yet)', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#6', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const result = await teamsReplyDraft.execute('send', { draft: {} as any, subject: task, content: { text: 'Sounds good!' } });
  assert.equal(result.text, 'Sounds good!');
  assert.equal(result.manual, true);
  assert.equal(result.channel, 'teams');
  assert.ok(typeof result.at === 'string');
});

test('teamsReplyDraft.legacyBroadcast: fires plate-updated so the old Dashboard card re-renders', () => {
  const events = teamsReplyDraft.legacyBroadcast!({} as any, 'completed');
  assert.deepEqual(events, [{ type: 'plate-updated' }]);
});

test('teamsReplyDraft.gates: exactly one gate, keyed "send"', () => {
  assert.equal(teamsReplyDraft.gates.length, 1);
  assert.equal(teamsReplyDraft.gates[0].key, 'send');
});

test('teamsReplyDraft.generate: with Gemini configured, first generation gathers context and drafts', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#7', 'Sounds good, will do.');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const gatherMock = mockGatherReplyContext('gathered: ticket ETICK-1 is In Progress');
  const geminiMock = mockGemini({ action: 'draft', draftText: 'A context-informed reply.', note: 'Used gathered context.' });
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  try {
    const result = await teamsReplyDraft.generate({ draftId: 1, subject: task, history: [] });
    assert.deepEqual(result, {
      mode: 'draft',
      content: { text: 'A context-informed reply.', gatheredContext: 'gathered: ticket ETICK-1 is In Progress' },
      note: 'Used gathered context.',
    });
    assert.equal(gatherMock.mock.callCount(), 1);
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherMock.mock.restore();
    geminiMock.mock.restore();
  }
});

test('teamsReplyDraft.generate: a genuine ambiguity produces a clarifying question instead of a draft', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#8', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const gatherMock = mockGatherReplyContext();
  const geminiMock = mockGemini({ action: 'clarify', question: 'Do you want to accept or push back on the deadline?', draftText: 'best-effort fallback' });
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  try {
    const result = await teamsReplyDraft.generate({ draftId: 1, subject: task, history: [] });
    assert.deepEqual(result, { mode: 'question', text: 'Do you want to accept or push back on the deadline?' });
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherMock.mock.restore();
    geminiMock.mock.restore();
  }
});

test('teamsReplyDraft.generate: answering the user\'s question about the draft leaves content untouched', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#9', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const gatherMock = mockGatherReplyContext();
  const geminiMock = mockGemini({ action: 'answer', answer: 'I flagged it as urgent because the sender used "ASAP".', draftText: 'unused' });
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  try {
    const result = await teamsReplyDraft.generate({
      draftId: 1,
      subject: task,
      priorContent: { text: 'Sure thing.', gatheredContext: 'cached context' },
      history: [{ id: 1, draftId: 1, turn: 1, role: 'assistant', kind: 'draft', text: null, content: { text: 'Sure thing.' }, createdAt: '' }],
      instruction: 'why is this urgent?',
    });
    assert.deepEqual(result, { mode: 'answer', text: 'I flagged it as urgent because the sender used "ASAP".' });
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherMock.mock.restore();
    geminiMock.mock.restore();
  }
});

test('teamsReplyDraft.generate: reuses cached gatheredContext on a refine turn instead of re-gathering', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#10', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const gatherMock = mockGatherReplyContext('should not be called again');
  const geminiMock = mockGemini({ action: 'draft', draftText: 'Shorter reply.' });
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  try {
    const result = await teamsReplyDraft.generate({
      draftId: 1,
      subject: task,
      priorContent: { text: 'A longer reply.', gatheredContext: 'previously cached context' },
      history: [{ id: 1, draftId: 1, turn: 1, role: 'assistant', kind: 'draft', text: null, content: { text: 'A longer reply.' }, createdAt: '' }],
      instruction: 'make it shorter',
    });
    assert.deepEqual(result, { mode: 'draft', content: { text: 'Shorter reply.', gatheredContext: 'previously cached context' }, note: undefined });
    assert.equal(gatherMock.mock.callCount(), 0);
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherMock.mock.restore();
    geminiMock.mock.restore();
  }
});

test('teamsReplyDraft.generate: after 3 clarifying questions, forces a draft even if the model still says "clarify"', async () => {
  const teamsId = seedTask('teams_message', 'reply-kinds-test/teams#11', 'ok');
  const task = (await teamsReplyDraft.loadSubject(String(teamsId)))!;
  const gatherMock = mockGatherReplyContext();
  const geminiMock = mockGemini({ action: 'clarify', question: 'One more thing?', draftText: 'Forced best-effort draft.' });
  const questionHistory = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1,
    draftId: 1,
    turn: i + 1,
    role: 'assistant' as const,
    kind: 'question' as const,
    text: `question ${i + 1}`,
    content: null,
    createdAt: '',
  }));
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  try {
    const result = await teamsReplyDraft.generate({
      draftId: 1,
      subject: task,
      priorContent: { text: '', gatheredContext: 'ctx' },
      history: questionHistory,
      instruction: 'here is my answer',
    });
    assert.equal(result.mode, 'draft');
    assert.equal((result as any).content.text, 'Forced best-effort draft.');
  } finally {
    updateSettings({ geminiApiKey: '' });
    gatherMock.mock.restore();
    geminiMock.mock.restore();
  }
});

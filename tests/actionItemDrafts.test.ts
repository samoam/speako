import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestJiraFields,
  suggestConfluenceFields,
  suggestEmailFields,
  suggestTeamsMessageFields,
  suggestScheduleMeetingFields,
} from '../src/summarization/actionItemDrafts';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { ActionItem } from '../src/storage/summaryRepository';

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 1,
    sessionId: 's',
    owner: null,
    description: 'Update JIRA:PROJ-42 status to in progress',
    dueDate: null,
    status: 'open',
    confidence: 'manual',
    type: 'jira',
    externalRef: null,
    ...overrides,
  };
}

function mockGemini(fake: unknown) {
  return mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
}

test('suggestJiraFields: throws when Gemini is not configured', async () => {
  await assert.rejects(() => suggestJiraFields(item()), /GEMINI_API_KEY/);
});

test('suggestJiraFields: parses a full suggestion', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({
    issueType: 'Task',
    summary: 'Move PROJ-42 to In Progress',
    description: 'Detailed context here.',
    transition: 'In Progress',
    comment: 'Kicking this off now.',
  });
  try {
    const result = await suggestJiraFields(item());
    assert.deepEqual(result, {
      issueType: 'Task',
      summary: 'Move PROJ-42 to In Progress',
      description: 'Detailed context here.',
      transition: 'In Progress',
      comment: 'Kicking this off now.',
    });
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('suggestJiraFields: falls back sensibly when fields are missing from the response', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({});
  try {
    const result = await suggestJiraFields(item({ description: 'File a bug about the crash' }));
    assert.equal(result.issueType, 'Task');
    assert.equal(result.summary, 'File a bug about the crash');
    assert.equal(result.transition, null);
    assert.equal(result.comment, 'File a bug about the crash');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('suggestConfluenceFields: parses a full suggestion', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({ title: 'Architecture Decision', content: '## Context\n\n...' });
  try {
    const result = await suggestConfluenceFields(item({ type: 'confluence', description: 'Document the new auth flow' }));
    assert.deepEqual(result, { title: 'Architecture Decision', content: '## Context\n\n...' });
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('suggestConfluenceFields: falls back to the raw description when fields are missing', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mockGemini({});
  try {
    const result = await suggestConfluenceFields(item({ type: 'confluence', description: 'Document the new auth flow' }));
    assert.equal(result.title, 'Document the new auth flow');
    assert.equal(result.content, 'Document the new auth flow');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('suggestEmailFields: parses a full suggestion and falls back sensibly when fields are missing', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  let spy = mockGemini({ subject: 'Follow-up on Q3 report', body: 'Hi team, following up on the Q3 report.' });
  try {
    const result = await suggestEmailFields(item({ type: 'email', description: 'Send the Q3 report to finance' }));
    assert.deepEqual(result, { subject: 'Follow-up on Q3 report', body: 'Hi team, following up on the Q3 report.' });
  } finally {
    spy.mock.restore();
  }
  spy = mockGemini({});
  try {
    const result = await suggestEmailFields(item({ type: 'email', description: 'Send the Q3 report to finance' }));
    assert.equal(result.subject, 'Send the Q3 report to finance');
    assert.equal(result.body, 'Send the Q3 report to finance');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('suggestTeamsMessageFields: parses a full suggestion and falls back to the raw description', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  let spy = mockGemini({ message: 'Hey — can you take a look at the PR when you get a sec?' });
  try {
    const result = await suggestTeamsMessageFields(item({ type: 'teams_message', description: 'Ask Bob to review the PR' }));
    assert.deepEqual(result, { message: 'Hey — can you take a look at the PR when you get a sec?' });
  } finally {
    spy.mock.restore();
  }
  spy = mockGemini({});
  try {
    const result = await suggestTeamsMessageFields(item({ type: 'teams_message', description: 'Ask Bob to review the PR' }));
    assert.equal(result.message, 'Ask Bob to review the PR');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('suggestScheduleMeetingFields: parses a full suggestion and falls back sensibly when fields are missing', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  let spy = mockGemini({ title: 'Q3 Budget Review', details: 'Follow-up meeting to review the Q3 budget numbers.' });
  try {
    const result = await suggestScheduleMeetingFields(item({ type: 'schedule_meeting', description: 'Set up a meeting to review Q3 budget' }));
    assert.deepEqual(result, { title: 'Q3 Budget Review', details: 'Follow-up meeting to review the Q3 budget numbers.' });
  } finally {
    spy.mock.restore();
  }
  spy = mockGemini({});
  try {
    const result = await suggestScheduleMeetingFields(item({ type: 'schedule_meeting', description: 'Set up a meeting to review Q3 budget' }));
    assert.equal(result.title, 'Set up a meeting to review Q3 budget');
    assert.equal(result.details, 'Set up a meeting to review Q3 budget');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveSummaryAndActionItems,
  insertManualActionItem,
  deleteActionItem,
  getActionItems,
  getActionItem,
  setActionItemType,
  setActionItemExternalRef,
  getUnnotifiedReminders,
  markReminderNotified,
  setActionItemStatus,
} from '../src/storage/summaryRepository';
import { createSession } from '../src/storage/segmentRepository';

const SUMMARY = {
  overview: 'o',
  keyDecisions: 'd',
  discussionTopics: 't',
  nextSteps: 'n',
  topics: ['topic'],
  modelUsed: 'test-model',
};

test('summaryRepository: insertManualActionItem creates an open, manual-confidence item', () => {
  createSession('sr-manual', ['en-US'], 'Manual', { sessionType: 'personal' });
  const item = insertManualActionItem('sr-manual', { description: 'Follow up with Bob', owner: 'Bob', dueDate: '2026-09-01' });
  assert.equal(item.sessionId, 'sr-manual');
  assert.equal(item.description, 'Follow up with Bob');
  assert.equal(item.owner, 'Bob');
  assert.equal(item.dueDate, '2026-09-01');
  assert.equal(item.status, 'open');
  assert.equal(item.confidence, 'manual');
  assert.deepEqual(getActionItems('sr-manual'), [item]);
});

test('summaryRepository: insertManualActionItem defaults owner/dueDate to null and type to "general" when omitted', () => {
  createSession('sr-manual-min', ['en-US'], 'Manual Min', { sessionType: 'personal' });
  const item = insertManualActionItem('sr-manual-min', { description: 'Just a task' });
  assert.equal(item.owner, null);
  assert.equal(item.dueDate, null);
  assert.equal(item.type, 'general');
});

test('summaryRepository: insertManualActionItem honors an explicit type', () => {
  createSession('sr-manual-type', ['en-US'], 'Manual Type', { sessionType: 'personal' });
  const item = insertManualActionItem('sr-manual-type', { description: 'Email the client', type: 'email' });
  assert.equal(item.type, 'email');
});

test('summaryRepository: setActionItemType updates only the type', () => {
  createSession('sr-settype', ['en-US'], 'Set Type', { sessionType: 'personal' });
  const item = insertManualActionItem('sr-settype', { description: 'Something' });
  setActionItemType(item.id, 'jira');
  const updated = getActionItem(item.id)!;
  assert.equal(updated.type, 'jira');
  assert.equal(updated.status, 'open');
  assert.equal(updated.description, 'Something');
});

test('summaryRepository: insertManualActionItem defaults externalRef to null, and setActionItemExternalRef round-trips it', () => {
  createSession('sr-extref', ['en-US'], 'Ext Ref', { sessionType: 'personal' });
  const item = insertManualActionItem('sr-extref', { description: 'File a ticket', type: 'jira' });
  assert.equal(item.externalRef, null);

  const ref = { tool: 'jira' as const, action: 'created' as const, key: 'PROJ-7', url: 'https://jira.example.com/browse/PROJ-7', at: '2026-01-01T00:00:00.000Z' };
  setActionItemExternalRef(item.id, ref);
  assert.deepEqual(getActionItem(item.id)!.externalRef, ref);
});

test('summaryRepository: deleteActionItem removes only the targeted item', () => {
  createSession('sr-delete', ['en-US'], 'Delete', { sessionType: 'personal' });
  const a = insertManualActionItem('sr-delete', { description: 'Keep me' });
  const b = insertManualActionItem('sr-delete', { description: 'Delete me' });
  deleteActionItem(b.id);
  assert.deepEqual(getActionItems('sr-delete'), [a]);
  assert.equal(getActionItem(b.id), undefined);
});

test('summaryRepository: regenerating the AI summary preserves manually-added items but replaces AI-extracted ones', () => {
  createSession('sr-preserve', ['en-US'], 'Preserve', { sessionType: 'personal' });
  const manual = insertManualActionItem('sr-preserve', { description: 'My own task' });
  saveSummaryAndActionItems('sr-preserve', SUMMARY, [
    { owner: 'Alice', description: 'AI task 1', dueDate: null, confidence: 'explicit', type: 'code_change' },
  ]);

  let items = getActionItems('sr-preserve');
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.id === manual.id && i.confidence === 'manual' && i.type === 'general'));
  assert.ok(items.some((i) => i.description === 'AI task 1' && i.confidence === 'explicit' && i.type === 'code_change'));

  // Regenerate again with different AI output — the manual item must survive,
  // the previous AI item must not.
  saveSummaryAndActionItems('sr-preserve', SUMMARY, [
    { owner: 'Alice', description: 'AI task 2', dueDate: null, confidence: 'inferred' },
  ]);

  items = getActionItems('sr-preserve');
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.id === manual.id));
  assert.ok(!items.some((i) => i.description === 'AI task 1'));
  assert.ok(items.some((i) => i.description === 'AI task 2'));
});

test('getUnnotifiedReminders: only returns open, unnotified reminder-type items with a due date', () => {
  createSession('sr-reminders', ['en-US'], 'Reminders', { sessionType: 'personal' });
  const reminder = insertManualActionItem('sr-reminders', { description: 'Follow up with legal', type: 'reminder', dueDate: '2026-01-01' });
  insertManualActionItem('sr-reminders', { description: 'No due date', type: 'reminder' });
  insertManualActionItem('sr-reminders', { description: 'Not a reminder', type: 'general', dueDate: '2026-01-01' });

  const candidates = getUnnotifiedReminders().filter((i) => i.sessionId === 'sr-reminders');
  assert.deepEqual(candidates.map((i) => i.id), [reminder.id]);
});

test('markReminderNotified: excludes the item from getUnnotifiedReminders afterward', () => {
  createSession('sr-reminder-notified', ['en-US'], 'Reminders', { sessionType: 'personal' });
  const reminder = insertManualActionItem('sr-reminder-notified', { description: 'Ping the vendor', type: 'reminder', dueDate: '2026-01-01' });

  assert.ok(getUnnotifiedReminders().some((i) => i.id === reminder.id));
  markReminderNotified(reminder.id);
  assert.ok(!getUnnotifiedReminders().some((i) => i.id === reminder.id));
});

test('getUnnotifiedReminders: a "done" reminder is excluded even if never notified', () => {
  createSession('sr-reminder-done', ['en-US'], 'Reminders', { sessionType: 'personal' });
  const reminder = insertManualActionItem('sr-reminder-done', { description: 'Already handled', type: 'reminder', dueDate: '2026-01-01' });
  setActionItemStatus(reminder.id, 'done');
  assert.ok(!getUnnotifiedReminders().some((i) => i.id === reminder.id));
});

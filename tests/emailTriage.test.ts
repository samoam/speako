import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/storage/db';
import { getUntriagedEmailMessages, classifyMessage } from '../src/communications/emailTriage';

const insertMessage = db.prepare(`
  INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
  VALUES (@id, 'email', @title, @participants, @occurredAt, @bodyText)
`);

function cleanup() {
  db.prepare(`DELETE FROM email_message_triage WHERE message_id LIKE 'email-triage-test:%'`).run();
  db.prepare(`DELETE FROM external_messages WHERE id LIKE 'email-triage-test:%'`).run();
}

test('getUntriagedEmailMessages: returns inbox emails not yet triaged', () => {
  cleanup();
  try {
    insertMessage.run({
      id: 'email-triage-test:1',
      title: 'Quarterly report',
      participants: JSON.stringify(['alice@example.com']),
      occurredAt: new Date().toISOString(),
      bodyText: 'Please review the attached report.',
    });
    const untriaged = getUntriagedEmailMessages();
    assert.ok(untriaged.some((m) => m.id === 'email-triage-test:1'));
  } finally {
    cleanup();
  }
});

test('getUntriagedEmailMessages: excludes already-triaged messages', () => {
  cleanup();
  try {
    insertMessage.run({
      id: 'email-triage-test:2',
      title: 'Newsletter',
      participants: JSON.stringify(['news@example.com']),
      occurredAt: new Date().toISOString(),
      bodyText: 'This week in tech...',
    });
    db.prepare(`
      INSERT INTO email_message_triage (message_id, needs_reply, summary, draft_reply)
      VALUES ('email-triage-test:2', 0, 'Weekly newsletter.', NULL)
    `).run();
    const untriaged = getUntriagedEmailMessages();
    assert.ok(!untriaged.some((m) => m.id === 'email-triage-test:2'));
  } finally {
    cleanup();
  }
});

test('classifyMessage: falls back to a truncated summary and no draft when Gemini is not configured', async () => {
  const message = {
    id: 'email-triage-test:fallback',
    source: 'email' as const,
    title: 'Quarterly report',
    participants: ['alice@example.com'],
    occurredAt: new Date().toISOString(),
    bodyText: 'x'.repeat(300),
  };
  const result = await classifyMessage(message);
  assert.equal(result.needsReply, false);
  assert.equal(result.draftReply, null);
  assert.equal(result.summary, message.bodyText.slice(0, 200));
});

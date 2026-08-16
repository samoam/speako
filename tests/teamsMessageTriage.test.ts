import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/storage/db';
import { detectMyTeamsDisplayName, getUntriagedTeamsMessages, classifyMessage } from '../src/communications/teamsMessageTriage';

const insertMessage = db.prepare(`
  INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
  VALUES (@id, 'teams', @title, @participants, @occurredAt, @bodyText)
`);

function seedChat(chatTitle: string, senders: string[]) {
  senders.forEach((sender, i) => {
    insertMessage.run({
      id: `triage-test:${chatTitle}:${i}`,
      title: chatTitle,
      participants: JSON.stringify([sender]),
      occurredAt: new Date().toISOString(),
      bodyText: `Message from ${sender}`,
    });
  });
}

function cleanup() {
  db.prepare(`DELETE FROM external_messages WHERE id LIKE 'triage-test:%'`).run();
}

test('detectMyTeamsDisplayName: picks the sender present across the most distinct chats', () => {
  cleanup();
  try {
    // "Me" replies in every chat; each other person only appears in their own chat.
    seedChat('Alice', ['Alice', 'Me']);
    seedChat('Bob', ['Bob', 'Me']);
    seedChat('Team chat', ['Charlie', 'Me']);

    assert.equal(detectMyTeamsDisplayName(), 'Me');
  } finally {
    cleanup();
  }
});

test('detectMyTeamsDisplayName: returns null when there is no Teams data yet', () => {
  cleanup();
  assert.equal(detectMyTeamsDisplayName(), null);
});

test('getUntriagedTeamsMessages: excludes the caller\'s own outgoing messages', () => {
  cleanup();
  try {
    seedChat('Alice', ['Alice', 'Me']);
    const untriaged = getUntriagedTeamsMessages('Me');
    assert.ok(untriaged.every((m) => m.participants[0] !== 'Me'));
    assert.ok(untriaged.some((m) => m.participants[0] === 'Alice'));
  } finally {
    cleanup();
  }
});

test('classifyMessage: falls back to a truncated summary and no draft when Gemini is not configured', async () => {
  const message = {
    id: 'triage-test:fallback',
    source: 'teams' as const,
    title: 'Design meeting',
    participants: ['Alice'],
    occurredAt: new Date().toISOString(),
    bodyText: 'x'.repeat(300),
  };
  const result = await classifyMessage(message, 'Me');
  assert.equal(result.directedAtMe, false);
  assert.equal(result.draftReply, null);
  assert.equal(result.summary, message.bodyText.slice(0, 200));
});

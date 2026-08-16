import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeConnectorCliModule from '../src/integrations/claudeConnectorCli';
import { mapTeamsMessageToExternalMessage, fetchRecentTeamsMessages, syncTeamsMessages } from '../src/integrations/teamsConnectorSync';

test('mapTeamsMessageToExternalMessage: titles from the chat topic map, trims the summary as bodyText', () => {
  const titles = new Map([['chat-1', 'Project Sync']]);
  const msg = mapTeamsMessageToExternalMessage(
    { id: 'msg-1', chatId: 'chat-1', createdDateTime: '2026-08-10T09:00:00Z', summary: '  Standup notes attached.  ', from: { displayName: 'Alice' } },
    titles
  );
  assert.equal(msg.id, 'msg-1');
  assert.equal(msg.source, 'teams');
  assert.equal(msg.title, 'Project Sync');
  assert.deepEqual(msg.participants, ['Alice']);
  assert.equal(msg.occurredAt, '2026-08-10T09:00:00Z');
  assert.equal(msg.bodyText, 'Standup notes attached.');
});

test('mapTeamsMessageToExternalMessage: falls back to the sender\'s display name when the chat has no topic (1:1 DM)', () => {
  const titles = new Map([['chat-2', null]]);
  const msg = mapTeamsMessageToExternalMessage(
    { id: 'msg-2', chatId: 'chat-2', createdDateTime: '2026-08-10T09:05:00Z', from: { displayName: 'Bob' } },
    titles
  );
  assert.equal(msg.title, 'Bob');
});

test('mapTeamsMessageToExternalMessage: defaults title/participants/bodyText when absent and the chat is unknown', () => {
  const msg = mapTeamsMessageToExternalMessage({ id: 'msg-3', chatId: 'chat-unknown', createdDateTime: '2026-08-10T09:10:00Z' }, new Map());
  assert.equal(msg.title, null);
  assert.deepEqual(msg.participants, []);
  assert.equal(msg.bodyText, '');
});

test('fetchRecentTeamsMessages: delegates to the shared paginateConnectorTool helper with the right tool/args', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async () => [
    { id: 'a', chatId: 'c1', createdDateTime: '2026-08-10T12:00:00Z' },
    { id: 'b', chatId: 'c1', createdDateTime: '2026-08-10T12:01:00Z' },
  ]);
  try {
    const messages = await fetchRecentTeamsMessages('2026-08-01T00:00:00Z');
    assert.deepEqual(
      messages.map((m) => m.id),
      ['a', 'b']
    );
    assert.equal(spy.mock.callCount(), 1);
    const call = spy.mock.calls[0]!.arguments[0]!;
    assert.equal(call.tool, 'chat_message_search');
    assert.equal(call.args.afterDateTime, '2026-08-01T00:00:00Z');
  } finally {
    spy.mock.restore();
  }
});

test('syncTeamsMessages: upserts every fetched message using chat titles from teams_list_chats, and reports the count', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async (opts: any) => {
    if (opts.tool === 'chat_message_search') {
      return [{ id: 'x', chatId: 'chat-9', createdDateTime: '2026-08-10T12:00:00Z', summary: 'hi', from: { displayName: 'Alice' } }];
    }
    if (opts.tool === 'teams_list_chats') {
      return [{ id: 'chat-9', chatType: 'oneOnOne', topic: null }];
    }
    throw new Error(`unexpected tool ${opts.tool}`);
  });
  try {
    const result = await syncTeamsMessages();
    assert.equal(result.messageCount, 1);
  } finally {
    spy.mock.restore();
  }
});

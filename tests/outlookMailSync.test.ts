import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as claudeConnectorCliModule from '../src/integrations/claudeConnectorCli';
import { mapEmailToExternalMessage, fetchRecentEmails, syncOutlookMail } from '../src/integrations/outlookMailSync';

test('mapEmailToExternalMessage: extracts participants from sender/recipients and uses the preview summary as bodyText', () => {
  const msg = mapEmailToExternalMessage({
    id: 'msg-1',
    subject: 'Budget review',
    sender: 'alice@acceo.com',
    recipients: ['bob@acceo.com'],
    receivedDateTime: '2026-08-10T12:00:00Z',
    summary: "  Let's meet Thursday.  ",
  });
  assert.equal(msg.id, 'msg-1');
  assert.equal(msg.source, 'email');
  assert.equal(msg.title, 'Budget review');
  assert.deepEqual(msg.participants, ['alice@acceo.com', 'bob@acceo.com']);
  assert.equal(msg.occurredAt, '2026-08-10T12:00:00Z');
  assert.equal(msg.bodyText, "Let's meet Thursday.");
});

test('mapEmailToExternalMessage: defaults title/participants/bodyText when absent', () => {
  const msg = mapEmailToExternalMessage({ id: 'msg-2', receivedDateTime: '2026-08-10T12:00:00Z' });
  assert.equal(msg.title, null);
  assert.deepEqual(msg.participants, []);
  assert.equal(msg.bodyText, '');
});

test('fetchRecentEmails: delegates to the shared paginateConnectorTool helper with the right tool/args', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async () => [
    { id: 'a', receivedDateTime: '2026-08-10T12:00:00Z' },
    { id: 'b', receivedDateTime: '2026-08-10T12:01:00Z' },
  ]);
  try {
    const emails = await fetchRecentEmails('2026-08-01T00:00:00Z');
    assert.deepEqual(
      emails.map((e) => e.id),
      ['a', 'b']
    );
    assert.equal(spy.mock.callCount(), 1);
    const call = spy.mock.calls[0]!.arguments[0]!;
    assert.equal(call.tool, 'outlook_email_search');
    assert.equal(call.args.afterDateTime, '2026-08-01T00:00:00Z');
  } finally {
    spy.mock.restore();
  }
});

test('syncOutlookMail: upserts every fetched email and reports the count', async () => {
  const spy = mock.method(claudeConnectorCliModule, 'paginateConnectorTool', async () => [
    { id: 'x', subject: 'Hi', receivedDateTime: '2026-08-10T12:00:00Z', summary: 'body' },
  ]);
  try {
    const result = await syncOutlookMail();
    assert.equal(result.emailCount, 1);
  } finally {
    spy.mock.restore();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isOutlookDesktopConfigured, mapOutlookItemToExternalMessage } from '../src/integrations/outlookDesktop';

test('isOutlookDesktopConfigured: reflects the current platform (Outlook COM automation is Windows-only)', () => {
  assert.equal(isOutlookDesktopConfigured(), process.platform === 'win32');
});

test('mapOutlookItemToExternalMessage: namespaces id, trims body, defaults missing fields', () => {
  const msg = mapOutlookItemToExternalMessage({
    id: 'ABC123',
    subject: 'Budget review',
    receivedTime: '2026-08-10T12:00:00.000Z',
    participants: ['alice@acceo.com', 'bob@acceo.com'],
    bodyText: '  Let\'s meet Thursday.  \n',
  });
  assert.equal(msg.id, 'outlook-desktop:ABC123');
  assert.equal(msg.source, 'email');
  assert.equal(msg.title, 'Budget review');
  assert.deepEqual(msg.participants, ['alice@acceo.com', 'bob@acceo.com']);
  assert.equal(msg.occurredAt, '2026-08-10T12:00:00.000Z');
  assert.equal(msg.bodyText, "Let's meet Thursday.");
});

test('mapOutlookItemToExternalMessage: defaults title/participants/bodyText when absent', () => {
  const msg = mapOutlookItemToExternalMessage({ id: 'DEF456', receivedTime: '2026-08-10T12:00:00.000Z' });
  assert.equal(msg.title, null);
  assert.deepEqual(msg.participants, []);
  assert.equal(msg.bodyText, '');
});

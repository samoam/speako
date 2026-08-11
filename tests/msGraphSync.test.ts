import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPlainText, mapEmailToExternalMessage, mapChatMessageToExternalMessage } from '../src/integrations/msGraphSync';

test('htmlToPlainText: strips tags, style/script blocks, and decodes common entities', () => {
  const html = '<style>.x{color:red}</style><p>Hello&nbsp;&amp;&nbsp;World</p><script>evil()</script><p>Second line</p>';
  const text = htmlToPlainText(html);
  assert.ok(!text.includes('<'));
  assert.ok(!text.includes('evil()'));
  assert.match(text, /Hello & World/);
  assert.match(text, /Second line/);
});

test('htmlToPlainText: converts <br> and block-closing tags to newlines', () => {
  const html = '<div>Line one<br>Line two</div><div>Line three</div>';
  const text = htmlToPlainText(html);
  assert.match(text, /Line one\nLine two/);
  assert.match(text, /Line three/);
});

test('mapEmailToExternalMessage: extracts participants from from/toRecipients and strips HTML body', () => {
  const msg = mapEmailToExternalMessage({
    id: 'msg-1',
    subject: 'Budget review',
    receivedDateTime: '2026-08-10T12:00:00Z',
    from: { emailAddress: { address: 'alice@acceo.com' } },
    toRecipients: [{ emailAddress: { address: 'bob@acceo.com' } }, { emailAddress: {} }],
    body: { contentType: 'html', content: '<p>Let\'s meet <b>Thursday</b>.</p>' },
  });
  assert.equal(msg.id, 'msg-1');
  assert.equal(msg.source, 'email');
  assert.equal(msg.title, 'Budget review');
  assert.deepEqual(msg.participants, ['alice@acceo.com', 'bob@acceo.com']);
  assert.equal(msg.occurredAt, '2026-08-10T12:00:00Z');
  assert.match(msg.bodyText, /Let's meet Thursday\./);
  assert.ok(!msg.bodyText.includes('<'));
});

test('mapEmailToExternalMessage: falls back to bodyPreview when body is absent', () => {
  const msg = mapEmailToExternalMessage({
    id: 'msg-2',
    receivedDateTime: '2026-08-10T12:00:00Z',
    bodyPreview: 'Plain preview text',
  });
  assert.equal(msg.title, null);
  assert.deepEqual(msg.participants, []);
  assert.equal(msg.bodyText, 'Plain preview text');
});

test('mapChatMessageToExternalMessage: namespaces id by chat, extracts sender display name', () => {
  const msg = mapChatMessageToExternalMessage({
    id: 'msg-9',
    chatId: 'chat-1',
    chatTopic: 'Project Sync',
    createdDateTime: '2026-08-10T09:00:00Z',
    from: { user: { displayName: 'Alice' } },
    body: { contentType: 'text', content: 'Standup notes attached' },
  });
  assert.equal(msg.id, 'chat-1:msg-9');
  assert.equal(msg.source, 'teams');
  assert.equal(msg.title, 'Project Sync');
  assert.deepEqual(msg.participants, ['Alice']);
  assert.equal(msg.occurredAt, '2026-08-10T09:00:00Z');
  assert.equal(msg.bodyText, 'Standup notes attached');
});

test('mapChatMessageToExternalMessage: strips HTML body and handles missing sender/topic', () => {
  const msg = mapChatMessageToExternalMessage({
    id: 'msg-10',
    chatId: 'chat-2',
    chatTopic: null,
    createdDateTime: '2026-08-10T09:05:00Z',
    body: { contentType: 'html', content: '<div>Hi <b>team</b></div>' },
  });
  assert.equal(msg.title, null);
  assert.deepEqual(msg.participants, []);
  assert.match(msg.bodyText, /Hi team/);
});

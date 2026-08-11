import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, listSessions } from '../src/storage/segmentRepository';

test('createSession: defaults sessionKind to "meeting" when omitted', () => {
  createSession('kind-1', ['en-US'], 'Plain session');
  const found = listSessions().find((s) => s.id === 'kind-1');
  assert.equal(found?.sessionKind, 'meeting');
});

test('createSession: sessionKind "practice" round-trips via listSessions', () => {
  createSession('kind-2', ['en-US'], 'Practice: Some meeting', { sessionType: 'personal', sessionKind: 'practice' });
  const found = listSessions().find((s) => s.id === 'kind-2');
  assert.equal(found?.sessionKind, 'practice');
});

test('createSession: sessionKind "chat" round-trips via listSessions', () => {
  createSession('kind-3', ['en-US'], 'Chat 1/1/2026', { sessionType: 'personal', sessionKind: 'chat' });
  const found = listSessions().find((s) => s.id === 'kind-3');
  assert.equal(found?.sessionKind, 'chat');
});

test('listSessions: sessionKind is orthogonal to sessionType — a work meeting stays "meeting"', () => {
  createSession('kind-4', ['en-US'], 'Sprint planning', { sessionType: 'work' });
  const found = listSessions().find((s) => s.id === 'kind-4');
  assert.equal(found?.sessionType, 'work');
  assert.equal(found?.sessionKind, 'meeting');
});

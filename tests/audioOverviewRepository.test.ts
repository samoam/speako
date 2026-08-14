import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertAudioOverview,
  getAudioOverview,
  getAudioOverviewForSession,
  deleteAudioOverview,
} from '../src/storage/audioOverviewRepository';
import { createSession, deleteSession } from '../src/storage/segmentRepository';

test('audioOverviewRepository: insert then get round-trips a subject-driven overview (no session)', () => {
  const overview = insertAudioOverview({
    subjectText: 'the roadmap',
    scriptText: 'HostA: hi\nHostB: hello',
    audioPath: '/tmp/a.wav',
  });
  assert.equal(overview.sessionId, null);
  assert.equal(overview.subjectText, 'the roadmap');
  assert.ok(overview.generatedAt);

  const fetched = getAudioOverview(overview.id);
  assert.deepEqual(fetched, overview);
});

test('audioOverviewRepository: insert then get round-trips a session-linked overview', () => {
  createSession('ao-session', ['en-US'], 'AO Session', { sessionType: 'personal' });
  const overview = insertAudioOverview({
    sessionId: 'ao-session',
    subjectText: 'AO Session',
    scriptText: 'HostA: hi\nHostB: hello',
    audioPath: '/tmp/b.wav',
  });
  assert.equal(overview.sessionId, 'ao-session');

  const fetched = getAudioOverviewForSession('ao-session');
  assert.deepEqual(fetched, overview);
});

test('audioOverviewRepository: getAudioOverviewForSession returns undefined when none exists', () => {
  createSession('ao-none', ['en-US'], 'AO None', { sessionType: 'personal' });
  assert.equal(getAudioOverviewForSession('ao-none'), undefined);
});

test('audioOverviewRepository: getAudioOverviewForSession returns the most recent when regenerated', () => {
  createSession('ao-regen', ['en-US'], 'AO Regen', { sessionType: 'personal' });
  insertAudioOverview({ sessionId: 'ao-regen', subjectText: 'AO Regen', scriptText: 'old', audioPath: '/tmp/old.wav' });
  const latest = insertAudioOverview({ sessionId: 'ao-regen', subjectText: 'AO Regen', scriptText: 'new', audioPath: '/tmp/new.wav' });

  const fetched = getAudioOverviewForSession('ao-regen');
  assert.deepEqual(fetched, latest);
});

test('audioOverviewRepository: deleteAudioOverview removes the row and returns its audioPath', () => {
  const overview = insertAudioOverview({ subjectText: 'to delete', scriptText: 'z', audioPath: '/tmp/delete-me.wav' });
  const path = deleteAudioOverview(overview.id);
  assert.equal(path, '/tmp/delete-me.wav');
  assert.equal(getAudioOverview(overview.id), undefined);
});

test('audioOverviewRepository: deleteAudioOverview returns undefined for an unknown id', () => {
  assert.equal(deleteAudioOverview(999999), undefined);
});

test('audioOverviewRepository: deleteSession cleans up its audio_overviews rows', () => {
  createSession('ao-cascade', ['en-US'], 'AO Cascade', { sessionType: 'personal' });
  const overview = insertAudioOverview({ sessionId: 'ao-cascade', subjectText: 'AO Cascade', scriptText: 'w', audioPath: '/tmp/cascade.wav' });
  deleteSession('ao-cascade');
  assert.equal(getAudioOverview(overview.id), undefined);
});

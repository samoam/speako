import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrep } from '../src/prep/PrepService';
import { createSession, getSession } from '../src/storage/segmentRepository';
import { getPrepBrief } from '../src/storage/prepBriefRepository';
import { updateSettings } from '../src/settingsStore';

test('runPrep: zero sources and no user notes still marks prepStatus "ready", not "failed"', async () => {
  // No Gemini key and no tools active — the generic workflow's jira/
  // confluence/email/teams sources are all tool-gated off, and its
  // personal_rag source finds nothing for a session with no corpus, so this
  // deterministically produces zero sources without any network call.
  updateSettings({ geminiApiKey: '' });
  const sessionId = 'prep-zero-sources';
  createSession(sessionId, ['en-US'], 'Untitled', { sessionType: 'work', meetingType: 'generic' });

  await runPrep({ sessionId, sessionName: 'Untitled', meetingType: 'generic', activeTools: [] });

  const session = getSession(sessionId);
  assert.equal(session!.prepStatus, 'ready');

  const brief = getPrepBrief(sessionId);
  assert.ok(brief);
  assert.match(brief!.prepBriefText, /No prep context was found/);
  assert.deepEqual(brief!.sourcesQueried, []);
});

test('runPrep: user notes alone (still zero sources) also marks prepStatus "ready"', async () => {
  updateSettings({ geminiApiKey: '' });
  const sessionId = 'prep-notes-only';
  createSession(sessionId, ['en-US'], 'Untitled 2', { sessionType: 'work', meetingType: 'generic' });

  await runPrep({
    sessionId,
    sessionName: 'Untitled 2',
    meetingType: 'generic',
    activeTools: [],
    userNotes: 'Ask about the migration timeline.',
  });

  const session = getSession(sessionId);
  assert.equal(session!.prepStatus, 'ready');

  const brief = getPrepBrief(sessionId);
  assert.ok(brief);
  assert.deepEqual(brief!.sourcesQueried, ['user_notes']);
});

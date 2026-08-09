import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrepBrief, getPrepBrief, updatePrepBriefText } from '../src/storage/prepBriefRepository';
import { createSession } from '../src/storage/segmentRepository';

test('prepBriefRepository: create then get round-trips without anticipatedQa', () => {
  createSession('pb-1', ['en-US'], 'Session 1', { sessionType: 'work', meetingType: 'generic' });
  createPrepBrief({
    sessionId: 'pb-1',
    meetingType: 'generic',
    sourcesQueried: ['jira_keyword_search'],
    prepBriefText: '## Brief\nSome text',
    rawContext: [{ name: 'jira_keyword_search', content: 'raw' }],
  });

  const fetched = getPrepBrief('pb-1');
  assert.ok(fetched);
  assert.equal(fetched!.prepBriefText, '## Brief\nSome text');
  assert.deepEqual(fetched!.sourcesQueried, ['jira_keyword_search']);
  assert.equal(fetched!.anticipatedQa, null);
});

test('prepBriefRepository: anticipatedQa round-trips when provided', () => {
  createSession('pb-2', ['en-US'], 'Session 2', { sessionType: 'work', meetingType: 'design_dev' });
  const anticipatedQa = {
    likelyQuestions: [{ question: 'Why this approach?', suggestedAnswer: 'Because X', basedOn: 'ETICK-1' }],
    questionsToAsk: [{ question: 'What about scale?', why: 'Risk area' }],
  };
  createPrepBrief({
    sessionId: 'pb-2',
    meetingType: 'design_dev',
    sourcesQueried: [],
    prepBriefText: 'brief',
    rawContext: [],
    anticipatedQa,
  });

  const fetched = getPrepBrief('pb-2');
  assert.deepEqual(fetched!.anticipatedQa, anticipatedQa);
});

test('prepBriefRepository: updatePrepBriefText only changes the text field', () => {
  createSession('pb-3', ['en-US'], 'Session 3', { sessionType: 'work', meetingType: 'generic' });
  createPrepBrief({
    sessionId: 'pb-3',
    meetingType: 'generic',
    sourcesQueried: ['a'],
    prepBriefText: 'original',
    rawContext: [{ name: 'a', content: 'x' }],
  });

  updatePrepBriefText('pb-3', 'edited by user');

  const fetched = getPrepBrief('pb-3');
  assert.equal(fetched!.prepBriefText, 'edited by user');
  assert.deepEqual(fetched!.sourcesQueried, ['a']); // untouched
});

test('prepBriefRepository: getPrepBrief returns undefined for an unknown session', () => {
  assert.equal(getPrepBrief('pb-does-not-exist'), undefined);
});

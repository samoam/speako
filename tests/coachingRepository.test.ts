import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCoachingFeedback, getCoachingFeedback } from '../src/storage/coachingRepository';
import { createSession } from '../src/storage/segmentRepository';

test('coachingRepository: getCoachingFeedback returns undefined when nothing saved', () => {
  createSession('cr-none', ['en-US'], 'No Feedback', { sessionType: 'personal' });
  assert.equal(getCoachingFeedback('cr-none'), undefined);
});

test('coachingRepository: save then get round-trips all fields including JSON arrays', () => {
  createSession('cr-basic', ['en-US'], 'Basic', { sessionType: 'personal' });
  const input = {
    talkTimeRatio: 0.62,
    fillerWordCount: 7,
    fillerWordExamples: ['um, so basically', 'like, you know'],
    feedbackPoints: [
      { category: 'clarity' as const, observation: 'obs', quote: 'a quote', suggestion: 'do this' },
      { category: 'talk_time' as const, observation: 'obs2', quote: null, suggestion: 'do that' },
    ],
  };
  const saved = saveCoachingFeedback('cr-basic', input);
  assert.equal(saved.sessionId, 'cr-basic');
  assert.ok(saved.generatedAt);

  const fetched = getCoachingFeedback('cr-basic');
  assert.ok(fetched);
  assert.equal(fetched!.talkTimeRatio, 0.62);
  assert.equal(fetched!.fillerWordCount, 7);
  assert.deepEqual(fetched!.fillerWordExamples, input.fillerWordExamples);
  assert.deepEqual(fetched!.feedbackPoints, input.feedbackPoints);
});

test('coachingRepository: saving again for the same session upserts rather than duplicating', () => {
  createSession('cr-upsert', ['en-US'], 'Upsert', { sessionType: 'personal' });
  saveCoachingFeedback('cr-upsert', { talkTimeRatio: 0.5, fillerWordCount: 1, fillerWordExamples: [], feedbackPoints: [] });
  saveCoachingFeedback('cr-upsert', { talkTimeRatio: 0.9, fillerWordCount: 9, fillerWordExamples: ['x'], feedbackPoints: [] });

  const fetched = getCoachingFeedback('cr-upsert');
  assert.equal(fetched!.talkTimeRatio, 0.9);
  assert.equal(fetched!.fillerWordCount, 9);
});

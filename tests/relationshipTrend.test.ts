import test from 'node:test';
import assert from 'node:assert/strict';
import { getRelationshipTrend } from '../src/insights/relationshipTrend';
import { createSession, endSession, findSessionSeries } from '../src/storage/segmentRepository';
import { insertSentimentScore } from '../src/storage/sentimentRepository';

test('findSessionSeries: returns [] when name is blank (a series can\'t be identified)', () => {
  assert.deepEqual(findSessionSeries('one_on_one', undefined), []);
  assert.deepEqual(findSessionSeries('one_on_one', ''), []);
});

test('findSessionSeries: matches by exact case-insensitive name, chronologically ascending', () => {
  const suffix = `rt-series-${Date.now()}`;
  createSession(`${suffix}-1`, ['en-US'], '1:1 with Sarah', { sessionType: 'work', meetingType: 'one_on_one' });
  endSession(`${suffix}-1`);
  createSession(`${suffix}-2`, ['en-US'], '1:1 WITH SARAH', { sessionType: 'work', meetingType: 'one_on_one' });
  endSession(`${suffix}-2`);
  createSession(`${suffix}-other`, ['en-US'], '1:1 with Bob', { sessionType: 'work', meetingType: 'one_on_one' });
  endSession(`${suffix}-other`);

  const series = findSessionSeries('one_on_one', '1:1 with Sarah');
  assert.deepEqual(
    series.map((s) => s.id),
    [`${suffix}-1`, `${suffix}-2`]
  );
});

test('getRelationshipTrend: returns [] for a non-one_on_one session', () => {
  const id = `rt-standup-${Date.now()}`;
  createSession(id, ['en-US'], 'Daily standup', { sessionType: 'work', meetingType: 'standup' });
  endSession(id);
  assert.deepEqual(getRelationshipTrend(id), []);
});

test('getRelationshipTrend: joins average sentiment per session in the series, in order', () => {
  const suffix = `rt-avg-${Date.now()}`;
  createSession(`${suffix}-1`, ['en-US'], '1:1 with Priya', { sessionType: 'work', meetingType: 'one_on_one' });
  endSession(`${suffix}-1`);
  createSession(`${suffix}-2`, ['en-US'], '1:1 with Priya', { sessionType: 'work', meetingType: 'one_on_one' });
  endSession(`${suffix}-2`);

  insertSentimentScore({ sessionId: `${suffix}-1`, speaker: 'You', startMs: 0, endMs: 1000, score: 0.5, magnitude: 0.5 });
  insertSentimentScore({ sessionId: `${suffix}-1`, speaker: 'Others', startMs: 1000, endMs: 2000, score: 0.3, magnitude: 0.3 });
  // session 2 has no sentiment rows at all (e.g. sentiment was disabled that day)

  const trend = getRelationshipTrend(`${suffix}-2`);
  assert.equal(trend.length, 2);
  assert.ok(Math.abs(trend[0].avgScore! - 0.4) < 1e-9);
  assert.equal(trend[0].scoreCount, 2);
  assert.equal(trend[1].avgScore, null);
  assert.equal(trend[1].scoreCount, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { getTodaysBriefing, saveTodaysBriefing, todayDateString } from '../src/storage/dailyBriefingRepository';

test('dailyBriefingRepository: getTodaysBriefing returns undefined before anything is saved', () => {
  assert.equal(getTodaysBriefing(), undefined);
});

test('dailyBriefingRepository: saveTodaysBriefing then getTodaysBriefing round-trips the content, keyed to today\'s date', () => {
  saveTodaysBriefing('3 new PR reviews owed.');
  const briefing = getTodaysBriefing();
  assert.equal(briefing?.content, '3 new PR reviews owed.');
  assert.equal(briefing?.date, todayDateString());
});

test('dailyBriefingRepository: saving again the same day overwrites the prior content', () => {
  saveTodaysBriefing('First draft.');
  saveTodaysBriefing('Updated draft.');
  assert.equal(getTodaysBriefing()?.content, 'Updated draft.');
});

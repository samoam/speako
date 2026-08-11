import test from 'node:test';
import assert from 'node:assert/strict';
import { getTopicFrequencies } from '../src/insights/topicTrend';
import { createSession } from '../src/storage/segmentRepository';
import { saveSummaryAndActionItems } from '../src/storage/summaryRepository';

function summaryWithTopics(topics: string[]) {
  return { overview: 'o', keyDecisions: 'k', discussionTopics: 'd', nextSteps: 'n', topics, modelUsed: 'test-model' };
}

test('getTopicFrequencies: aggregates topic counts across sessions, case-insensitively', () => {
  const suffix = `tt-${Date.now()}`;
  createSession(`${suffix}-a`, ['en-US'], 'A', { sessionType: 'personal' });
  createSession(`${suffix}-b`, ['en-US'], 'B', { sessionType: 'personal' });
  saveSummaryAndActionItems(`${suffix}-a`, summaryWithTopics(['mem0 cold-start', 'sprint velocity']), []);
  saveSummaryAndActionItems(`${suffix}-b`, summaryWithTopics(['Mem0 Cold-Start']), []);

  const frequencies = getTopicFrequencies();
  const memTopic = frequencies.find((f) => f.topic.toLowerCase() === 'mem0 cold-start');
  assert.ok(memTopic, 'expected the two differently-cased mentions to merge into one topic');
  assert.equal(memTopic!.count, 2);
  assert.equal(memTopic!.sessions.length, 2);
});

test('getTopicFrequencies: sessions without a summary contribute no topics', () => {
  const suffix = `tt-nosum-${Date.now()}`;
  createSession(suffix, ['en-US'], 'No Summary', { sessionType: 'personal' });
  const frequencies = getTopicFrequencies();
  assert.ok(!frequencies.some((f) => f.sessions.some((s) => s.sessionId === suffix)));
});

test('getTopicFrequencies: sorts by count descending', () => {
  const suffix = `tt-sort-${Date.now()}`;
  createSession(`${suffix}-1`, ['en-US'], '1', { sessionType: 'personal' });
  createSession(`${suffix}-2`, ['en-US'], '2', { sessionType: 'personal' });
  createSession(`${suffix}-3`, ['en-US'], '3', { sessionType: 'personal' });
  const rareTopicKey = `rare-topic-${suffix}`;
  const commonTopicKey = `common-topic-${suffix}`;
  saveSummaryAndActionItems(`${suffix}-1`, summaryWithTopics([commonTopicKey]), []);
  saveSummaryAndActionItems(`${suffix}-2`, summaryWithTopics([commonTopicKey]), []);
  saveSummaryAndActionItems(`${suffix}-3`, summaryWithTopics([rareTopicKey]), []);

  const frequencies = getTopicFrequencies();
  const commonIndex = frequencies.findIndex((f) => f.topic === commonTopicKey);
  const rareIndex = frequencies.findIndex((f) => f.topic === rareTopicKey);
  assert.ok(commonIndex < rareIndex, 'expected the topic mentioned twice to sort before the one mentioned once');
});

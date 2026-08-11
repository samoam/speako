import test from 'node:test';
import assert from 'node:assert/strict';
import { isFeatureActive, ALL_FEATURE_KEYS } from '../src/tools/activeFeatures';
import { createSession, getSession, setActiveFeatures } from '../src/storage/segmentRepository';

test('isFeatureActive: null activeFeatures means every feature is active (preserves pre-existing sessions\' behavior)', () => {
  for (const key of ALL_FEATURE_KEYS) {
    assert.equal(isFeatureActive(null, key), true);
  }
});

test('isFeatureActive: an explicit list only activates the features named in it', () => {
  assert.equal(isFeatureActive(['sentiment', 'rag'], 'sentiment'), true);
  assert.equal(isFeatureActive(['sentiment', 'rag'], 'rag'), true);
  assert.equal(isFeatureActive(['sentiment', 'rag'], 'triggers'), false);
  assert.equal(isFeatureActive(['sentiment', 'rag'], 'meetingState'), false);
});

test('isFeatureActive: an empty list disables every feature', () => {
  for (const key of ALL_FEATURE_KEYS) {
    assert.equal(isFeatureActive([], key), false);
  }
});

test('segmentRepository: createSession/getSession round-trip activeFeatures', () => {
  createSession('af-explicit', ['en-US'], 'Explicit features', { sessionType: 'personal', activeFeatures: ['sentiment', 'triggers'] });
  const row = getSession('af-explicit');
  assert.deepEqual(row?.activeFeatures, ['sentiment', 'triggers']);
});

test('segmentRepository: omitting activeFeatures at creation defaults to null ("all globally-enabled features")', () => {
  createSession('af-default', ['en-US'], 'Default features', { sessionType: 'personal' });
  const row = getSession('af-default');
  assert.equal(row?.activeFeatures, null);
});

test('segmentRepository: setActiveFeatures updates the persisted value', () => {
  createSession('af-update', ['en-US'], 'Updatable features', { sessionType: 'personal' });
  setActiveFeatures('af-update', ['rag']);
  const row = getSession('af-update');
  assert.deepEqual(row?.activeFeatures, ['rag']);
});

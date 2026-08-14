import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as speechAdaptation from '../src/speechAdaptation';
import { buildStreamingConfigRequest } from '../src/transcription/speechClient';

const FAKE_ADAPTATION = { phraseSets: [{ inlinePhraseSet: { phrases: [{ value: 'Speako', boost: 15 }] } }] } as any;

test('buildStreamingConfigRequest: includes adaptation for a real (non-auto) language code', () => {
  const spy = mock.method(speechAdaptation, 'buildAdaptationConfig', () => FAKE_ADAPTATION);
  try {
    const req = buildStreamingConfigRequest(1, ['en-US']);
    assert.deepEqual(req.streamingConfig.config.adaptation, FAKE_ADAPTATION);
  } finally {
    spy.mock.restore();
  }
});

test('buildStreamingConfigRequest: omits adaptation when languageCodes is auto-detect', () => {
  // Confirmed empirically against the real Speech-to-Text v2 API: combining
  // an inline-phrase-set adaptation config with languageCodes: ['auto']
  // makes the streaming call fail outright with "5 NOT_FOUND" — the whole
  // session gets zero transcript, not just degraded phrase-boosting.
  const spy = mock.method(speechAdaptation, 'buildAdaptationConfig', () => FAKE_ADAPTATION);
  try {
    const req = buildStreamingConfigRequest(1, ['auto']);
    assert.equal(req.streamingConfig.config.adaptation, undefined);
  } finally {
    spy.mock.restore();
  }
});

test('buildStreamingConfigRequest: omits adaptation when there is nothing to adapt with, regardless of language', () => {
  const spy = mock.method(speechAdaptation, 'buildAdaptationConfig', () => undefined);
  try {
    const req = buildStreamingConfigRequest(1, ['en-US']);
    assert.equal(req.streamingConfig.config.adaptation, undefined);
  } finally {
    spy.mock.restore();
  }
});

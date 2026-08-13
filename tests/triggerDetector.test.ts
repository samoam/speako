import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { TriggerDetector } from '../src/triggers/TriggerDetector';
import * as classifyModule from '../src/triggers/classify';
import { TranscriptSegment } from '../src/types';
import { updateSettings } from '../src/settingsStore';
import { createSession } from '../src/storage/segmentRepository';

const ABSENT = { present: false, confidence: 0, reason: '' };

function seg(text: string): TranscriptSegment {
  return { sessionId: 'trig-session', speaker: 'You', startMs: 0, endMs: 1000, text, isFinal: true };
}

test('TriggerDetector: fires code_reference for a code-related segment even when Gemini classification finds nothing', async () => {
  updateSettings({ triggerConfidenceThreshold: '0.5' });
  const classifySpy = mock.method(classifyModule, 'classifySegment', async () => ({
    factualClaim: ABSENT,
    decisionPoint: ABSENT,
    vagueness: ABSENT,
  }));
  createSession('trig-session-1', ['en-US'], 'Trigger test', { sessionType: 'personal' });
  const detector = new TriggerDetector('trig-session-1');
  const events: any[] = [];
  detector.on('trigger', (event) => events.push(event));
  try {
    await detector.onFinalSegment(seg('the verifyToken function in the auth service looks broken'));
    assert.ok(events.some((e) => e.category === 'code_reference'));
  } finally {
    classifySpy.mock.restore();
    updateSettings({ triggerConfidenceThreshold: '' });
  }
});

test('TriggerDetector: does not fire code_reference for an ordinary, non-technical segment', async () => {
  updateSettings({ triggerConfidenceThreshold: '0.5' });
  const classifySpy = mock.method(classifyModule, 'classifySegment', async () => ({
    factualClaim: ABSENT,
    decisionPoint: ABSENT,
    vagueness: ABSENT,
  }));
  const detector = new TriggerDetector('trig-session-2');
  const events: any[] = [];
  detector.on('trigger', (event) => events.push(event));
  try {
    await detector.onFinalSegment(seg('should we grab lunch before the next meeting'));
    assert.ok(!events.some((e) => e.category === 'code_reference'));
  } finally {
    classifySpy.mock.restore();
    updateSettings({ triggerConfidenceThreshold: '' });
  }
});

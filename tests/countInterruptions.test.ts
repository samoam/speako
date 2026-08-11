import test from 'node:test';
import assert from 'node:assert/strict';
import { countInterruptions } from '../src/coaching/analyzeConversation';
import { TranscriptSegment } from '../src/types';

function seg(speaker: string, startMs: number, endMs: number): TranscriptSegment {
  return { sessionId: 's', speaker, startMs, endMs, text: 'x', isFinal: true };
}

test('countInterruptions: no overlap at all counts zero for both directions', () => {
  const segments = [seg('You', 0, 1000), seg('Others', 1000, 2000), seg('You', 2000, 3000)];
  assert.deepEqual(countInterruptions(segments), { youInterruptedOthersCount: 0, othersInterruptedYouCount: 0 });
});

test('countInterruptions: "You" starting while "Others" is still talking counts as You interrupting Others', () => {
  const segments = [seg('Others', 0, 2000), seg('You', 1000, 1500)];
  assert.deepEqual(countInterruptions(segments), { youInterruptedOthersCount: 1, othersInterruptedYouCount: 0 });
});

test('countInterruptions: "Others" starting while "You" is still talking counts as Others interrupting You', () => {
  const segments = [seg('You', 0, 2000), seg('Others', 1000, 1500)];
  assert.deepEqual(countInterruptions(segments), { youInterruptedOthersCount: 0, othersInterruptedYouCount: 1 });
});

test('countInterruptions: counts multiple interruptions across a longer sequence', () => {
  const segments = [
    seg('You', 0, 1000),
    seg('Others', 500, 1500), // interrupts You
    seg('You', 1400, 2000), // interrupts Others
    seg('Others', 2000, 2500), // no overlap
  ];
  assert.deepEqual(countInterruptions(segments), { youInterruptedOthersCount: 1, othersInterruptedYouCount: 1 });
});

test('countInterruptions: ignores speakers other than "You"/"Others" (post-diarization sessions)', () => {
  const segments = [seg('Speaker 1', 0, 2000), seg('Speaker 2', 1000, 1500)];
  assert.deepEqual(countInterruptions(segments), { youInterruptedOthersCount: 0, othersInterruptedYouCount: 0 });
});

test('countInterruptions: handles out-of-order input by sorting on startMs first', () => {
  const segments = [seg('You', 1000, 1500), seg('Others', 0, 2000)];
  assert.deepEqual(countInterruptions(segments), { youInterruptedOthersCount: 1, othersInterruptedYouCount: 0 });
});

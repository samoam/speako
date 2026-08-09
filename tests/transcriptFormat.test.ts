import test from 'node:test';
import assert from 'node:assert/strict';
import { toPlainText } from '../src/transcriptFormat';
import { TranscriptSegment } from '../src/types';

test('toPlainText: formats each segment as [mm:ss] Speaker: text', () => {
  const segments: TranscriptSegment[] = [
    { sessionId: 's1', speaker: 'You', startMs: 0, endMs: 1000, text: 'Hello there.', isFinal: true },
    { sessionId: 's1', speaker: 'Others', startMs: 65000, endMs: 66000, text: 'Hi back.', isFinal: true },
  ];
  const result = toPlainText(segments);
  assert.equal(result, '[00:00] You: Hello there.\n[01:05] Others: Hi back.');
});

test('toPlainText: empty segment list returns empty string', () => {
  assert.equal(toPlainText([]), '');
});

test('toPlainText: preserves the given segment order (does not re-sort)', () => {
  const segments: TranscriptSegment[] = [
    { sessionId: 's1', speaker: 'You', startMs: 5000, endMs: 6000, text: 'Second in time but first in array.', isFinal: true },
    { sessionId: 's1', speaker: 'Others', startMs: 1000, endMs: 2000, text: 'First in time but second in array.', isFinal: true },
  ];
  const lines = toPlainText(segments).split('\n');
  assert.match(lines[0], /Second in time/);
  assert.match(lines[1], /First in time/);
});

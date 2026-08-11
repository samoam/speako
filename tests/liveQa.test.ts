import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { answerLiveQuestion } from '../src/qa/liveQa';
import { config } from '../src/config';
import { updateSettings } from '../src/settingsStore';
import * as ragModule from '../src/rag/rag';
import * as meetingStateModule from '../src/state/meetingState';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { TranscriptSegment } from '../src/types';

function makeSegment(i: number): TranscriptSegment {
  return { speaker: 'You', text: `segment ${i}`, startMs: i * 1000, endMs: i * 1000 + 500, isFinal: true } as TranscriptSegment;
}

test('answerLiveQuestion: only sends the last N transcript segments, relying on the rolling summary for earlier context', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const retrieveSpy = mock.method(ragModule, 'retrieve', async () => ({ chunks: [], suppressed: true }));
  const stateSpy = mock.method(meetingStateModule, 'getMeetingStateSnapshot', () => ({
    rollingSummary: 'Summary of everything so far.',
    openItems: [],
  }));

  let receivedPrompt = '';
  const clientSpy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async (params: any) => {
        receivedPrompt = params.contents;
        return { text: 'the answer', usageMetadata: undefined };
      },
    },
  }));

  try {
    const windowSize = config.liveQaTranscriptWindowSegments;
    const totalSegments = windowSize + 10;
    const segments = Array.from({ length: totalSegments }, (_, i) => makeSegment(i));

    const result = await answerLiveQuestion('session-1', 'What happened?', segments);

    assert.equal(result.answerText, 'the answer');
    // The earliest segments (outside the window) must not appear inline...
    assert.ok(!receivedPrompt.includes('segment 0'));
    assert.ok(!receivedPrompt.includes(`segment ${totalSegments - windowSize - 1}`));
    // ...while the most recent ones do.
    assert.ok(receivedPrompt.includes(`segment ${totalSegments - 1}`));
    assert.ok(receivedPrompt.includes(`segment ${totalSegments - windowSize}`));
    // The rolling summary carries the earlier context instead.
    assert.ok(receivedPrompt.includes('Summary of everything so far.'));
  } finally {
    retrieveSpy.mock.restore();
    stateSpy.mock.restore();
    clientSpy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

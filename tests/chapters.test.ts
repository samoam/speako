import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { detectChapters } from '../src/summarization/chapters';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';
import { TranscriptSegment } from '../src/types';

function seg(startMs: number, text: string): TranscriptSegment {
  return { sessionId: 's', speaker: 'You', startMs, endMs: startMs + 1000, text, isFinal: true };
}

test('detectChapters: throws when Gemini is not configured', async () => {
  await assert.rejects(() => detectChapters([seg(0, 'hello')]), /GEMINI_API_KEY/);
});

test('detectChapters: parses chapters and converts "[mm:ss]" timestamps to milliseconds', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const fake = {
    chapters: [
      { startTime: '00:00', title: 'Kickoff', summary: 'Opening remarks.' },
      { startTime: '02:30', title: 'Budget review', summary: 'Discussed Q3 budget.' },
    ],
  };
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
  try {
    const chapters = await detectChapters([seg(0, 'hello'), seg(150000, 'budget time')]);
    assert.deepEqual(chapters, [
      { startMs: 0, title: 'Kickoff', summary: 'Opening remarks.' },
      { startMs: 150000, title: 'Budget review', summary: 'Discussed Q3 budget.' },
    ]);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('detectChapters: drops a chapter with an unparseable timestamp rather than storing garbage', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const fake = {
    chapters: [
      { startTime: 'not a timestamp', title: 'Bad', summary: 'x' },
      { startTime: '01:00', title: 'Good', summary: 'y' },
    ],
  };
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
  try {
    const chapters = await detectChapters([seg(0, 'hello')]);
    assert.deepEqual(chapters, [{ startMs: 60000, title: 'Good', summary: 'y' }]);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('detectChapters: sorts chapters chronologically even if the model returns them out of order', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const fake = {
    chapters: [
      { startTime: '05:00', title: 'Later', summary: 'x' },
      { startTime: '00:10', title: 'Earlier', summary: 'y' },
    ],
  };
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: JSON.stringify(fake) }) },
  }));
  try {
    const chapters = await detectChapters([seg(0, 'hello')]);
    assert.deepEqual(
      chapters.map((c) => c.title),
      ['Earlier', 'Later']
    );
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

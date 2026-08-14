import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAudioOverviewScript,
  synthesizeAudioOverviewSpeech,
  generateAudioOverview,
} from '../src/summarization/generateAudioOverview';
import { updateSettings } from '../src/settingsStore';
import * as geminiClientModule from '../src/gemini/geminiClient';

function fakePcmResponse(pcmByteLength: number, mimeType = 'audio/L16;codec=pcm;rate=24000') {
  const pcm = Buffer.alloc(pcmByteLength, 1);
  return {
    candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64'), mimeType } }] } }],
  };
}

test('generateAudioOverviewScript: throws when Gemini is not configured', async () => {
  await assert.rejects(() => generateAudioOverviewScript('subject', 'context'), /GEMINI_API_KEY/);
});

test('generateAudioOverviewScript: returns the trimmed script text', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: '  HostA: hi\nHostB: hello\n  ' }) },
  }));
  try {
    const script = await generateAudioOverviewScript('subject', 'context');
    assert.equal(script, 'HostA: hi\nHostB: hello');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('generateAudioOverviewScript: throws on an empty script', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ text: '   ' }) },
  }));
  try {
    await assert.rejects(() => generateAudioOverviewScript('subject', 'context'), /empty script/);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('synthesizeAudioOverviewSpeech: throws when Gemini is not configured', async () => {
  await assert.rejects(() => synthesizeAudioOverviewSpeech('HostA: hi'), /GEMINI_API_KEY/);
});

test('synthesizeAudioOverviewSpeech: requests exactly two speaker voice configs', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  let capturedConfig: any;
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async (req: any) => {
        capturedConfig = req.config;
        return fakePcmResponse(10);
      },
    },
  }));
  try {
    await synthesizeAudioOverviewSpeech('HostA: hi\nHostB: hello');
    const voices = capturedConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs;
    assert.equal(voices.length, 2);
    assert.deepEqual(
      voices.map((v: any) => v.speaker),
      ['HostA', 'HostB']
    );
    assert.equal(capturedConfig.responseModalities[0], 'AUDIO');
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('synthesizeAudioOverviewSpeech: wraps the returned PCM in a WAV header sized off the parsed sample rate', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const pcmBytes = 1000;
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => fakePcmResponse(pcmBytes, 'audio/L16;codec=pcm;rate=24000') },
  }));
  try {
    const wav = await synthesizeAudioOverviewSpeech('HostA: hi\nHostB: hello');
    assert.equal(wav.length, 44 + pcmBytes);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 24000); // sample rate field
    assert.equal(wav.readUInt16LE(22), 1); // mono
    assert.equal(wav.readUInt32LE(40), pcmBytes); // data chunk size
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('synthesizeAudioOverviewSpeech: throws if the mimeType has no parseable rate', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => fakePcmResponse(10, 'audio/L16;codec=pcm') },
  }));
  try {
    await assert.rejects(() => synthesizeAudioOverviewSpeech('HostA: hi\nHostB: hello'), /sample rate/);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('synthesizeAudioOverviewSpeech: throws when the response has no audio data', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: { generateContent: async () => ({ candidates: [{ content: { parts: [{}] } }] }) },
  }));
  try {
    await assert.rejects(() => synthesizeAudioOverviewSpeech('HostA: hi'), /did not include audio data/);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

test('generateAudioOverview: chains the script step into the speech step', async () => {
  updateSettings({ geminiApiKey: 'fake-key-for-test' });
  let ttsContents: string | undefined;
  const spy = mock.method(geminiClientModule, 'getGeminiClient', () => ({
    models: {
      generateContent: async (req: any) => {
        if (req.config?.responseModalities) {
          ttsContents = req.contents;
          return fakePcmResponse(20);
        }
        return { text: 'HostA: hi\nHostB: hello' };
      },
    },
  }));
  try {
    const result = await generateAudioOverview('subject', 'context');
    assert.equal(result.scriptText, 'HostA: hi\nHostB: hello');
    assert.equal(ttsContents, 'HostA: hi\nHostB: hello');
    assert.equal(result.audioBuffer.length, 44 + 20);
  } finally {
    spy.mock.restore();
    updateSettings({ geminiApiKey: '' });
  }
});

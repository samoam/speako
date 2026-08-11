import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config';
import { LiveVoiceSession } from '../../src/voice/liveVoiceSession';
import { buildChatInstruction } from '../../src/voice/systemInstructions';

// Live's cold start + a full round trip (connect -> model turn -> audio back)
// is slower than a plain generateContent call — generous timeout, not a sign
// anything is wrong.
const TIMEOUT_MS = 60_000;

test(
  'LiveVoiceSession: a real connect + text-triggered turn returns real audio back',
  { skip: !config.geminiApiKey, timeout: TIMEOUT_MS },
  async () => {
    const session = new LiveVoiceSession({ systemInstruction: buildChatInstruction(), tools: [] });

    const audioChunks: Buffer[] = [];
    let outputText = '';
    let done = false;
    let sawError: Error | null = null;

    session.on('audio', (chunk: Buffer) => audioChunks.push(chunk));
    session.on('outputTranscript', (text: string) => {
      outputText += text;
    });
    // generationComplete, not turnComplete — turnComplete deliberately waits
    // for an artificial "playback finished" delay that only makes sense for
    // a client driving its own realtime playback, confirmed via real traffic
    // where it didn't arrive within several seconds of generationComplete
    // for a longer response.
    session.on('generationComplete', () => {
      done = true;
    });
    session.on('error', (err: Error) => {
      sawError = err;
    });

    await session.connect();
    session.sendText('Say the single word "acknowledged" and nothing else.');

    const start = Date.now();
    while (!done && !sawError && Date.now() - start < TIMEOUT_MS - 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // generationComplete means text generation is done, not that every audio
    // chunk has arrived yet — confirmed via real traffic where a short reply
    // saw generationComplete fire before any audio chunk showed up. Same
    // "trailing results after the signal" pattern session.ts already handles
    // for the STT pipeline. Give it a moment before asserting/closing.
    if (!sawError) await new Promise((resolve) => setTimeout(resolve, 2_000));

    session.close();

    if (sawError) throw sawError;
    assert.ok(done, 'expected the Live session to report generationComplete');
    assert.ok(audioChunks.length > 0, 'expected at least one real audio chunk back from Gemini Live');
    assert.ok(outputText.trim().length > 0, 'expected a real output transcript back from Gemini Live');
    console.log(`[integration] LiveVoiceSession received ${audioChunks.length} audio chunk(s), transcript: "${outputText.trim()}"`);
  }
);

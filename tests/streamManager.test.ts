import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'events';
import { StreamManager, RecognizeCall } from '../src/transcription/streamManager';

/** Stands in for the gax duplex stream returned by speechClient.streamingRecognize(). */
class FakeCall extends EventEmitter implements RecognizeCall {
  written: unknown[] = [];
  ended = false;

  write(msg: unknown): void {
    this.written.push(msg);
  }

  end(): void {
    this.ended = true;
    // Mirrors a real gRPC stream: 'end' fires asynchronously after end() is called.
    setImmediate(() => this.emit('end'));
  }
}

function makeChunk(ms: number, sampleRate: number, channelCount: number): Buffer {
  const frames = Math.round((ms / 1000) * sampleRate);
  return Buffer.alloc(frames * 2 * channelCount);
}

test('emits a segment per result, mapping channelTag to speaker and computing absolute endMs', () => {
  const calls: FakeCall[] = [];
  const sm = new StreamManager(2, ['en-US'], () => {
    const c = new FakeCall();
    calls.push(c);
    return c;
  });

  const segments: any[] = [];
  sm.on('segment', (s) => segments.push(s));

  sm.start();
  calls[0].emit('data', {
    results: [
      {
        alternatives: [{ transcript: 'hello there' }],
        isFinal: true,
        channelTag: 1,
        resultEndOffset: { seconds: 1, nanos: 0 },
      },
      {
        alternatives: [{ transcript: 'hi back' }],
        isFinal: true,
        channelTag: 2,
        resultEndOffset: { seconds: 1, nanos: 500000000 },
      },
    ],
  });
  sm.stop();

  assert.equal(segments.length, 2);
  assert.equal(segments[0].speaker, 'You');
  assert.equal(segments[0].text, 'hello there');
  assert.equal(segments[0].endMs, 1000);
  assert.equal(segments[1].speaker, 'Others');
  assert.equal(segments[1].endMs, 1500);
});

test('buffers audio during restart and flushes it exactly once, in order, to the new stream', async () => {
  const calls: FakeCall[] = [];
  const sm = new StreamManager(1, ['en-US'], () => {
    const c = new FakeCall();
    calls.push(c);
    return c;
  }) as any;

  sm.start();
  const oldCall: FakeCall = calls[0];

  const chunkA = Buffer.from([1, 1]);
  const chunkB = Buffer.from([2, 2]);
  const chunkC = Buffer.from([3, 3]);

  sm.writeAudio(chunkA); // sent immediately — no restart in progress yet
  sm.restart(); // internal method; exercised directly to test the handoff deterministically
  assert.equal(sm.restarting, true);

  sm.writeAudio(chunkB); // must be buffered, not sent to oldCall or a not-yet-open newCall
  sm.writeAudio(chunkC);

  assert.equal(oldCall.written.length, 1);
  assert.deepEqual(oldCall.written[0], { audio: chunkA });

  // Let FakeCall's queued 'end' event fire, which triggers finishRestart().
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2, 'a new call should have been opened after the old one ended');
  const newCall = calls[1];

  assert.equal(newCall.written.length, 2, 'both buffered chunks should be flushed to the new call');
  assert.deepEqual(newCall.written[0], { audio: chunkB });
  assert.deepEqual(newCall.written[1], { audio: chunkC });

  // Never re-sent to the old call — no duplication.
  assert.equal(oldCall.written.length, 1);

  sm.stop();
});

test('reconstructs absolute timestamps across a restart via the running audio offset', async () => {
  const sampleRate = 16000;
  const calls: FakeCall[] = [];
  const sm = new StreamManager(1, ['en-US'], () => {
    const c = new FakeCall();
    calls.push(c);
    return c;
  }) as any;

  sm.start();

  sm.writeAudio(makeChunk(2000, sampleRate, 1)); // 2s of audio on the first stream
  sm.restart();
  sm.writeAudio(makeChunk(500, sampleRate, 1)); // 0.5s buffered during handoff -> lands on new stream

  await new Promise((resolve) => setImmediate(resolve));
  const newCall: FakeCall = calls[1];

  const segments: any[] = [];
  sm.on('segment', (s: any) => segments.push(s));

  // The new stream's own clock starts at 0; this result ends 0.5s into it —
  // exactly the buffered chunk. Absolute time should be 2000ms + 500ms = 2500ms.
  newCall.emit('data', {
    results: [
      {
        alternatives: [{ transcript: 'continued' }],
        isFinal: true,
        channelTag: 1,
        resultEndOffset: { seconds: 0, nanos: 500000000 },
      },
    ],
  });

  assert.equal(segments.length, 1);
  assert.equal(segments[0].endMs, 2500);

  sm.stop();
});

test('pause(): closes the current call, opens no new one, and drops audio written while paused', async () => {
  const calls: FakeCall[] = [];
  const sm = new StreamManager(1, ['en-US'], () => {
    const c = new FakeCall();
    calls.push(c);
    return c;
  }) as any;

  sm.start();
  const call0: FakeCall = calls[0];
  sm.pause();
  assert.equal(call0.ended, true);

  sm.writeAudio(Buffer.from([9, 9])); // must be dropped outright, not buffered for later
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1, 'no new call should open while paused');
  sm.stop();
});

test('resume(): reopens a call, and segment timestamps continue from actual audio time — the pause itself contributes nothing', async () => {
  const sampleRate = 16000;
  const calls: FakeCall[] = [];
  const sm = new StreamManager(1, ['en-US'], () => {
    const c = new FakeCall();
    calls.push(c);
    return c;
  }) as any;

  sm.start();
  sm.writeAudio(makeChunk(1000, sampleRate, 1)); // 1s of real audio before pausing
  sm.pause();
  await new Promise((resolve) => setImmediate(resolve)); // let the paused call's (harmless) 'end' fire

  sm.resume();
  assert.equal(calls.length, 2, 'resume() should open a fresh call');
  const newCall: FakeCall = calls[1];

  const segments: any[] = [];
  sm.on('segment', (s: any) => segments.push(s));

  newCall.emit('data', {
    results: [
      {
        alternatives: [{ transcript: 'after pause' }],
        isFinal: true,
        channelTag: 1,
        resultEndOffset: { seconds: 0, nanos: 200000000 },
      },
    ],
  });

  // 1000ms of real audio before the pause + 200ms into the resumed stream —
  // however long the pause lasted in wall-clock time, it adds zero.
  assert.equal(segments[0].endMs, 1200);

  sm.stop();
});

test('pause(): a no-op once the stream is already fully stopped', () => {
  const sm = new StreamManager(1, ['en-US'], () => new FakeCall()) as any;
  sm.start();
  sm.stop();
  sm.pause();
  assert.equal(sm.paused, false);
});

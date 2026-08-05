import { EventEmitter } from 'events';
import { config } from '../config';
import { speechClient, buildStreamingConfigRequest } from './speechClient';
import { TranscriptSegment, SpeakerLabel } from '../types';

const BYTES_PER_SAMPLE = 2; // LINEAR16
const MAX_AUDIO_CHUNK_BYTES = 25600; // hard server-side limit per streamed audio message

function durationToMs(d: { seconds?: unknown; nanos?: number } | undefined): number {
  if (!d) return 0;
  const seconds = typeof d.seconds === 'object' ? Number(String(d.seconds)) : Number(d.seconds || 0);
  return seconds * 1000 + (d.nanos || 0) / 1e6;
}

function channelToSpeaker(channelTag: number | undefined): SpeakerLabel {
  return channelTag === 2 ? 'Others' : 'You';
}

/** A minimal duplex-stream shape — matches the gax stream returned by speechClient._streamingRecognize(). */
export interface RecognizeCall {
  write(msg: unknown): void;
  end(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

function defaultCreateCall(channelCount: number, languageCodes: string[]): RecognizeCall {
  // Deliberately the underscore-prefixed method, not the public streamingRecognize()
  // convenience wrapper: that wrapper predates v2's `recognizer` field and never sets
  // it, silently sending an invalid request (server error: "RESOURCE_PROJECT_INVALID").
  // _streamingRecognize() is the raw bidi stream matching the actual v2 proto.
  const call = speechClient._streamingRecognize();
  call.write(buildStreamingConfigRequest(channelCount, languageCodes));
  return call as unknown as RecognizeCall;
}

/**
 * Manages a resilient streaming connection to Google Speech-to-Text v2.
 *
 * Google's streaming call is proactively restarted every `streamRestartSeconds`
 * (the v2 API doesn't document a hard cap like v1's ~5 minutes, but long-lived
 * streams are still restarted periodically for resilience against server-side
 * disconnects). To avoid dropping or duplicating audio at the restart boundary:
 * while the old stream is being closed and the new one opened, incoming audio
 * is buffered in memory rather than sent anywhere; once the old stream fully
 * ends, the buffer is flushed — in order — to the new stream exactly once.
 *
 * Absolute session timestamps are reconstructed by tracking the total audio
 * duration written across all streams (`totalMsWritten`) and recording, for
 * each stream, the offset at which it started (`streamOffsetMs`). A response's
 * `resultEndOffset` is relative to its own stream, so absolute time is
 * `streamOffsetMs + resultEndOffsetMs`.
 */
export class StreamManager extends EventEmitter {
  private channelCount: number;
  private createCall: (channelCount: number) => RecognizeCall;
  private call: RecognizeCall | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarting = false;
  private pendingChunks: Buffer[] = [];

  private totalMsWritten = 0;
  private streamOffsetMs = 0;
  private lastEndMsBySpeaker: Record<string, number> = { You: 0, Others: 0 };

  private stopped = false;

  constructor(
    channelCount: number,
    languageCodes: string[],
    createCall: (channelCount: number) => RecognizeCall = (cc) => defaultCreateCall(cc, languageCodes)
  ) {
    super();
    this.channelCount = channelCount;
    this.createCall = createCall;
  }

  start(): void {
    this.streamOffsetMs = 0;
    this.openStream();
    this.scheduleRestart();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.call) {
      try {
        this.call.end();
      } catch {
        // stream may already be closed
      }
    }
  }

  writeAudio(chunk: Buffer): void {
    if (this.stopped) return;

    const frames = chunk.length / (BYTES_PER_SAMPLE * this.channelCount);
    this.totalMsWritten += (frames / config.sampleRate) * 1000;

    if (this.restarting) {
      this.pendingChunks.push(chunk);
      return;
    }
    this.writeToCall(chunk);
  }

  private writeToCall(chunk: Buffer): void {
    if (!this.call) return;
    try {
      // The server rejects any single audio message over MAX_AUDIO_CHUNK_BYTES.
      for (let offset = 0; offset < chunk.length; offset += MAX_AUDIO_CHUNK_BYTES) {
        this.call.write({ audio: chunk.subarray(offset, offset + MAX_AUDIO_CHUNK_BYTES) });
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  private openStream(): void {
    const call = this.createCall(this.channelCount);

    call.on('data', (response: any) => this.handleResponse(response));
    call.on('error', (err: Error) => {
      this.emit('error', err);
      if (!this.stopped) this.restart();
    });
    call.on('end', () => {
      // A stream we intentionally closed during restart signals completion here.
      if (this.restarting) this.finishRestart();
    });

    this.call = call;
  }

  private handleResponse(response: any): void {
    const results = response.results || [];
    for (const result of results) {
      const alt = result.alternatives?.[0];
      if (!alt?.transcript) continue;

      const speaker = channelToSpeaker(result.channelTag);
      const endMs = this.streamOffsetMs + durationToMs(result.resultEndOffset);
      const startMs = this.lastEndMsBySpeaker[speaker] ?? 0;

      const segment: TranscriptSegment = {
        sessionId: '', // filled in by the caller (transcription/index.ts) which owns the session id
        speaker,
        startMs,
        endMs,
        text: alt.transcript,
        isFinal: !!result.isFinal,
      };

      if (result.isFinal) {
        this.lastEndMsBySpeaker[speaker] = endMs;
      }

      this.emit('segment', segment);
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.restart(), config.streamRestartSeconds * 1000);
  }

  private restart(): void {
    if (this.stopped || this.restarting) return;
    this.restarting = true;

    const old = this.call;
    this.call = null;

    // Safety valve: if the old stream never emits 'end' (e.g. it's already
    // wedged from the error that triggered this restart), don't stall forever.
    const forceFlush = setTimeout(() => this.finishRestart(), 5000);
    this.once('__restart_finished', () => clearTimeout(forceFlush));

    if (old) {
      try {
        old.end();
      } catch {
        this.finishRestart();
      }
    } else {
      this.finishRestart();
    }
  }

  private finishRestart(): void {
    if (!this.restarting) return;
    this.restarting = false;
    this.emit('__restart_finished');

    this.streamOffsetMs = this.totalMsWritten - this.pendingBufferedMs();
    this.openStream();

    const buffered = this.pendingChunks;
    this.pendingChunks = [];
    for (const chunk of buffered) this.writeToCall(chunk);

    if (!this.stopped) this.scheduleRestart();
  }

  private pendingBufferedMs(): number {
    const bytes = this.pendingChunks.reduce((sum, c) => sum + c.length, 0);
    const frames = bytes / (BYTES_PER_SAMPLE * this.channelCount);
    return (frames / config.sampleRate) * 1000;
  }
}

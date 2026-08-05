import { v4 as uuid } from 'uuid';
import { config } from './config';
import { SoxCapture } from './audio-capture/soxCapture';
import { WavRecorder } from './audio-capture/wavRecorder';
import { StreamManager } from './transcription/streamManager';
import { InterfaceServer } from './interface/server';
import { createSession, endSession, insertFinalSegment, getSegmentsForSession } from './storage/segmentRepository';
import { insertSentimentScore } from './storage/sentimentRepository';
import { analyzeSentiment } from './sentiment/sentiment';
import { TriggerDetector } from './triggers/TriggerDetector';
import { TriggerEvent } from './storage/triggerRepository';
import { indexSessionForRag } from './rag/rag';
import { generateSuggestion } from './suggestions/generate';
import { insertSuggestion } from './storage/suggestionRepository';
import { factCheckClaim } from './factcheck/factcheck';
import { insertFactCheck } from './storage/factCheckRepository';
import { isAnyFactCheckSourceConfigured } from './factcheck/factcheck';
import { updateMeetingState } from './state/meetingState';
import { computeWaveformEnvelope } from './audio-capture/waveform';
import { TranscriptSegment } from './types';

export class Session {
  readonly id: string;
  private capture: SoxCapture;
  private streamManager: StreamManager;
  private wavRecorder: WavRecorder;
  private triggerDetector: TriggerDetector;
  /** Finalized segments seen since the last meeting-state update — compared against config.meetingStateUpdateEverySegments to decide when to run the next incremental update. */
  private segmentsSinceStateUpdate = 0;

  constructor(private ui: InterfaceServer, private languageCodes: string[], private name?: string) {
    this.id = uuid();
    this.capture = new SoxCapture();
    this.streamManager = new StreamManager(this.capture.channelCount, languageCodes);
    this.wavRecorder = new WavRecorder(this.id, this.capture.channelCount);
    this.triggerDetector = new TriggerDetector(this.id);
  }

  start(): void {
    createSession(this.id, this.languageCodes, this.name);
    this.ui.setSession(this.id, this.name);

    this.streamManager.on('segment', (segment: TranscriptSegment) => {
      segment.sessionId = this.id;
      this.ui.broadcastSegment(segment);
      if (!segment.isFinal) return;
      try {
        // Google can deliver trailing results for already-buffered audio after
        // stop() is called — if the session's row was deleted in the meantime
        // (a legitimate concurrent user action), this insert fails its foreign
        // key. That's fine to drop; it must never crash the process.
        insertFinalSegment(segment);
      } catch (err: any) {
        console.error(`[storage] failed to persist trailing segment for session ${this.id}:`, err.message);
      }
      if (config.sentimentEnabled) this.scoreSentiment(segment);
      if (config.triggerDetectionEnabled) {
        this.triggerDetector.onFinalSegment(segment).catch((err: any) => {
          console.error(`[triggers] unexpected failure for session ${this.id}:`, err.message);
        });
      }
      if (config.meetingStateEnabled && config.geminiApiKey) {
        this.segmentsSinceStateUpdate++;
        if (this.segmentsSinceStateUpdate >= config.meetingStateUpdateEverySegments) {
          this.segmentsSinceStateUpdate = 0;
          // Fire-and-forget: never blocks live transcription/triggers on this.
          updateMeetingState(this.id).catch(() => {});
        }
      }
    });
    this.triggerDetector.on('trigger', (event: TriggerEvent, segmentText: string) => {
      this.ui.broadcastTrigger(event);
      if (config.ragEnabled && config.geminiApiKey) this.generateAndBroadcastSuggestion(event, segmentText);
      if (event.category === 'factual_claim') {
        if (isAnyFactCheckSourceConfigured() && config.geminiApiKey) {
          this.runFactCheck(event, segmentText);
        } else {
          // No source configured/no Gemini key — tell the UI now so the
          // Triggers tab doesn't sit on "Checking…" forever.
          this.ui.broadcastTriggerFactCheck(this.id, event.id, 'not-configured', null);
        }
      }
    });
    this.streamManager.on('error', (err: any) => {
      console.error('[transcription] error:', err.message);
      if (err.details) console.error('  details:', err.details);
      if (err.metadata) console.error('  metadata:', JSON.stringify(err.metadata));
      if (err.code) console.error('  code:', err.code);
    });
    this.streamManager.start();

    this.capture.on('data', (chunk: Buffer) => {
      this.streamManager.writeAudio(chunk);
      this.wavRecorder.write(chunk);
      if (config.waveformEnabled) {
        const envelope = computeWaveformEnvelope(chunk, this.capture.channelCount);
        if (envelope.length > 0) this.ui.broadcastWaveform(this.id, envelope);
      }
    });
    this.capture.on('log', (line: string) => console.error('[sox]', line));
    this.capture.on('error', (err: Error) => console.error('[audio-capture] error:', err.message));
    this.capture.start();

    console.log(`Session ${this.id} started (channels: ${this.capture.channelCount}).`);
  }

  /**
   * Stops capture/transcription and finalizes the local WAV recording only —
   * no upload or diarization happens here. Speaker identification is a
   * separate, explicit, on-demand action (POST /api/sessions/:id/diarize)
   * so audio is never sent to the cloud without the user asking for it.
   */
  stop(): void {
    this.capture.stop();
    this.streamManager.stop();
    endSession(this.id);
    this.wavRecorder.finish().catch((err) => console.error('[audio] failed to finalize recording:', err.message));
    this.triggerDetector.stop();
    console.log(`Session ${this.id} stopped.`);

    if (config.ragEnabled && config.geminiApiKey) {
      // StreamManager may still deliver a trailing final result for already-buffered
      // audio for a moment after stop() returns (same pattern as elsewhere in this
      // file) — wait briefly so indexing captures the complete transcript, not a
      // snapshot that's missing the last segment or two.
      setTimeout(() => {
        const segments = getSegmentsForSession(this.id);
        indexSessionForRag(this.id, segments).catch((err: any) => {
          console.error(`[rag] failed to index session ${this.id}:`, err.message);
        });
      }, 3000);
    }
  }

  /** Fire-and-forget: grounds a fired trigger via RAG, generates a suggestion, persists/broadcasts it. Never throws. */
  private async generateAndBroadcastSuggestion(event: TriggerEvent, segmentText: string): Promise<void> {
    try {
      const generated = await generateSuggestion(event, segmentText);
      if (!generated) return; // suppressed — no grounding, or the model judged nothing worth surfacing

      const suggestion = insertSuggestion({
        sessionId: this.id,
        triggerId: event.id,
        triggerCategory: event.category,
        suggestionText: generated.text,
        sourceCitation: generated.citation,
        confidence: event.confidence,
      });
      this.ui.broadcastSuggestion(suggestion);
    } catch (err: any) {
      console.error(`[suggestions] failed for session ${this.id}:`, err.message);
    }
  }

  /** Fire-and-forget: checks a factual claim against Bitbucket/Jira/Confluence, persists the outcome, and only broadcasts a Suggestions-panel card on conflict — but always tells the Triggers tab the check's status. Never throws. */
  private async runFactCheck(event: TriggerEvent, segmentText: string): Promise<void> {
    try {
      console.log(`[factcheck] checking claim: "${segmentText}"`);
      const outcome = await factCheckClaim(segmentText, this.id);
      if (!outcome) {
        console.log('[factcheck] no source configured/applicable — skipped');
        this.ui.broadcastTriggerFactCheck(this.id, event.id, 'skipped', null);
        return;
      }

      const surfaced = outcome.result === 'conflict';
      console.log(
        `[factcheck] result=${outcome.result} sources=[${outcome.sourceQueried}] surfaced=${surfaced}`
      );
      const factCheck = insertFactCheck({
        sessionId: this.id,
        triggerId: event.id,
        claimText: segmentText,
        sourceQueried: outcome.sourceQueried,
        groundTruth: outcome.groundTruth,
        result: outcome.result,
        surfaced,
      });
      this.ui.broadcastTriggerFactCheck(this.id, event.id, 'checked', factCheck);
      // Matches and insufficient-info results still update the Triggers tab (above)
      // but never get a Suggestions-panel card — spec §4.2 point 5: no need to
      // congratulate correctness, and a low-confidence "needs verification" nudge
      // is worse than staying silent.
      if (surfaced) this.ui.broadcastFactCheck(factCheck);
    } catch (err: any) {
      console.error(`[factcheck] failed for session ${this.id}:`, err.message);
      this.ui.broadcastTriggerFactCheck(this.id, event.id, 'error', null);
    }
  }

  /** Fire-and-forget: scores one finalized segment and persists/broadcasts the result. Never throws. */
  private scoreSentiment(segment: TranscriptSegment): void {
    analyzeSentiment(segment.text)
      .then(({ score, magnitude }) => {
        try {
          // Same trailing-result-after-delete race as insertFinalSegment above — drop, don't crash.
          insertSentimentScore({
            sessionId: this.id,
            speaker: segment.speaker,
            startMs: segment.startMs,
            endMs: segment.endMs,
            score,
            magnitude,
          });
        } catch (err: any) {
          console.error(`[storage] failed to persist sentiment score for session ${this.id}:`, err.message);
          return;
        }
        this.ui.broadcastSentiment(this.id, segment.speaker, segment.startMs, segment.endMs, score, magnitude);
        if (config.triggerDetectionEnabled) this.triggerDetector.onSentimentScore(score, segment);
      })
      .catch((err: any) => console.error(`[sentiment] failed for session ${this.id}:`, err.message));
  }
}

import { EventEmitter } from 'events';
import { config } from '../config';
import { TranscriptSegment } from '../types';
import { classifySegment, CategoryResult } from './classify';
import { insertTrigger, TriggerCategory, TriggerEvent } from '../storage/triggerRepository';
import { getMeetingStateSnapshot } from '../state/meetingState';
import { looksCodeRelated } from '../router';

const SENTIMENT_WINDOW_SIZE = 5;

/**
 * Runs the Phase 3 §4 trigger-detection pipeline for one session: a Gemini-based
 * fast filter for factual-claim/decision-point/vagueness, a rolling-average
 * comparison for tone-shift (reuses the sentiment pipeline's scores), and a
 * timer-based check for unanswered questions. Applies confidence thresholds,
 * a per-category cooldown, and an overall rate limit (spec §4.3) before firing.
 *
 * This stage only detects and logs triggers — it does not yet run RAG or
 * generate a suggestion (that's the next build stage).
 */
export class TriggerDetector extends EventEmitter {
  private sentimentWindow: number[] = [];
  private lastFiredAt: Partial<Record<TriggerCategory, number>> = {};
  private recentFireTimestamps: number[] = [];
  private pendingQuestionTimer: NodeJS.Timeout | null = null;
  /**
   * The underlying meeting_state row only actually changes every
   * config.meetingStateUpdateEverySegments segments (see session.ts's
   * updateMeetingState cadence) — re-querying it here on every single
   * segment was re-reading identical data most of the time. Cached and
   * refreshed on the same cadence instead.
   */
  private cachedRollingSummary: string | undefined;
  private segmentsSinceStateFetch = 0;

  constructor(private sessionId: string) {
    super();
  }

  async onFinalSegment(segment: TranscriptSegment): Promise<void> {
    // A new segment is itself a "response" — whatever question was pending got addressed one way or
    // another (or the topic moved on), so stop waiting on it.
    this.clearPendingQuestion();

    if (segment.text.trim().endsWith('?')) {
      this.pendingQuestionTimer = setTimeout(() => {
        this.pendingQuestionTimer = null;
        this.maybeFire(
          'unanswered_question',
          { present: true, confidence: 0.7, reason: `No response within ${config.unansweredQuestionTimeoutMs / 1000}s of a question.` },
          segment
        );
      }, config.unansweredQuestionTimeoutMs);
    }

    let classification;
    try {
      if (this.segmentsSinceStateFetch === 0) {
        this.cachedRollingSummary = getMeetingStateSnapshot(this.sessionId).rollingSummary || undefined;
      }
      this.segmentsSinceStateFetch = (this.segmentsSinceStateFetch + 1) % config.meetingStateUpdateEverySegments;
      classification = await classifySegment(segment.text, this.cachedRollingSummary);
    } catch (err: any) {
      console.error(`[triggers] classification failed for session ${this.sessionId}:`, err.message);
      return;
    }

    this.maybeFire('factual_claim', classification.factualClaim, segment);
    this.maybeFire('decision_point', classification.decisionPoint, segment);
    this.maybeFire('vagueness', classification.vagueness, segment);

    // Plain keyword heuristic, not a Gemini classification — same
    // looksCodeRelated() check generic.ts/router.ts already use to decide
    // whether to query Bitbucket at prep time, reused here to fire live
    // instead of only at prep. Always fires on a match regardless of
    // whether any code source is actually configured, same as
    // factual_claim: the raw detection is still worth logging in the
    // Triggers tab; generateSuggestion() is what suppresses when there's
    // nothing to ground it in (see suggestions/generate.ts).
    if (looksCodeRelated(segment.text)) {
      this.maybeFire(
        'code_reference',
        { present: true, confidence: 0.6, reason: 'Mentions code/technical terminology.' },
        segment
      );
    }
  }

  /** Called once a sentiment score is available for a segment (see session.ts's scoreSentiment). */
  onSentimentScore(score: number, segment: TranscriptSegment): void {
    if (this.sentimentWindow.length > 0) {
      const avg = this.sentimentWindow.reduce((a, b) => a + b, 0) / this.sentimentWindow.length;
      const delta = Math.abs(score - avg);
      if (delta >= config.toneShiftDelta) {
        this.maybeFire(
          'tone_shift',
          { present: true, confidence: Math.min(1, delta), reason: `Sentiment shifted by ${delta.toFixed(2)} from the recent average.` },
          segment
        );
      }
    }

    this.sentimentWindow.push(score);
    if (this.sentimentWindow.length > SENTIMENT_WINDOW_SIZE) this.sentimentWindow.shift();
  }

  stop(): void {
    this.clearPendingQuestion();
  }

  private clearPendingQuestion(): void {
    if (this.pendingQuestionTimer) {
      clearTimeout(this.pendingQuestionTimer);
      this.pendingQuestionTimer = null;
    }
  }

  private maybeFire(category: TriggerCategory, result: CategoryResult, segment: TranscriptSegment): void {
    if (!result.present || result.confidence < config.triggerConfidenceThreshold) return;

    const now = Date.now();
    const lastFired = this.lastFiredAt[category];
    if (lastFired && now - lastFired < config.triggerCooldownMs) return;

    this.recentFireTimestamps = this.recentFireTimestamps.filter((t) => now - t < 60_000);
    if (this.recentFireTimestamps.length >= config.triggerRateLimitPerMinute) return;

    this.lastFiredAt[category] = now;
    this.recentFireTimestamps.push(now);

    let id: number;
    try {
      id = insertTrigger({
        sessionId: this.sessionId,
        category,
        confidence: result.confidence,
        reason: result.reason,
        startMs: segment.startMs,
        endMs: segment.endMs,
        segmentText: segment.text,
      });
    } catch (err: any) {
      // Same trailing-result-after-delete race handled elsewhere in the app — drop, don't crash.
      console.error(`[storage] failed to persist trigger for session ${this.sessionId}:`, err.message);
      return;
    }

    const event: TriggerEvent = {
      id,
      sessionId: this.sessionId,
      category,
      confidence: result.confidence,
      reason: result.reason,
      startMs: segment.startMs,
      endMs: segment.endMs,
      segmentText: segment.text,
    };
    // segment.text is also passed as a second emit argument for convenience
    // (used directly for suggestion generation's RAG query / the initial
    // fact-check) even though it's now on the event object too.
    this.emit('trigger', event, segment.text);
  }
}

/**
 * Live segments use a channel-based label ('You' | 'Others' — see NOTES.md).
 * Post-session diarization replaces these with dynamic 'Speaker N' labels.
 */
export type SpeakerLabel = 'You' | 'Others' | string;

export interface TranscriptSegment {
  sessionId: string;
  speaker: SpeakerLabel;
  /** Milliseconds since the session started. */
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
}

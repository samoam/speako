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

export interface AudioChunk {
  /** Raw interleaved PCM16 audio for this chunk. */
  data: Buffer;
  /** Number of channels present in `data` (1 = mic-only, 2 = mic + system). */
  channelCount: number;
}

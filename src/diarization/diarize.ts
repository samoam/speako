import { Storage } from '@google-cloud/storage';
import { config } from '../config';
import { speechClient, buildRecognizerPath } from '../transcription/speechClient';
import { TranscriptSegment } from '../types';

const storage = new Storage();

function durationToMs(d: { seconds?: unknown; nanos?: number } | undefined): number {
  if (!d) return 0;
  const seconds = typeof d.seconds === 'object' ? Number(String(d.seconds)) : Number(d.seconds || 0);
  return seconds * 1000 + (d.nanos || 0) / 1e6;
}

interface DiarizedWord {
  word: string;
  speakerLabel?: string;
  startOffset?: { seconds?: unknown; nanos?: number };
  endOffset?: { seconds?: unknown; nanos?: number };
}

/** Groups consecutive same-speaker words into one segment per speaker turn. */
function wordsToSegments(sessionId: string, words: DiarizedWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let currentLabel: string | undefined;
  let currentWords: string[] = [];
  let startMs = 0;
  let endMs = 0;

  const flush = () => {
    if (currentWords.length === 0) return;
    const speakerNum = Number(currentLabel ?? '0') + 1;
    segments.push({
      sessionId,
      speaker: `Speaker ${speakerNum}`,
      startMs,
      endMs,
      text: currentWords.join(' '),
      isFinal: true,
    });
    currentWords = [];
  };

  for (const w of words) {
    if (w.speakerLabel !== currentLabel) {
      flush();
      currentLabel = w.speakerLabel;
      startMs = durationToMs(w.startOffset);
    }
    currentWords.push(w.word);
    endMs = durationToMs(w.endOffset);
  }
  flush();

  return segments;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * batchRecognize occasionally rejects a request with an opaque
 * "Config contains unsupported fields" INVALID_ARGUMENT immediately after
 * uploading a new GCS object — confirmed transient by reproducing the exact
 * same request against the exact same already-uploaded file moments later
 * and having it succeed. Retrying with a short backoff absorbs this.
 */
async function batchRecognizeWithRetry(request: Parameters<typeof speechClient.batchRecognize>[0], attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await speechClient.batchRecognize(request);
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(1500 * attempt);
    }
  }
}

/**
 * Uploads a session's WAV recording to GCS and runs BatchRecognize with
 * diarization enabled, returning speaker-labeled segments. Diarization only
 * works via BatchRecognize (not StreamingRecognize — see NOTES.md), and
 * BatchRecognize only accepts GCS-hosted audio, hence the upload step.
 *
 * enableWordTimeOffsets must NOT be combined with enableWordConfidence when
 * diarizationConfig is set — the server rejects that combination outright
 * (confirmed empirically; not documented). Omit confidence to get timing.
 */
export async function diarizeSession(sessionId: string, wavPath: string, languageCodes: string[]): Promise<TranscriptSegment[]> {
  if (!config.gcsBucket) {
    throw new Error('GCS_BUCKET is not configured — skipping diarization.');
  }

  const objectName = `sessions/${sessionId}.wav`;
  await storage.bucket(config.gcsBucket).upload(wavPath, { destination: objectName });
  const gcsUri = `gs://${config.gcsBucket}/${objectName}`;

  const [operation] = await batchRecognizeWithRetry({
    recognizer: buildRecognizerPath(),
    config: {
      autoDecodingConfig: {},
      model: config.speechModel,
      languageCodes,
      features: {
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true,
        diarizationConfig: {
          minSpeakerCount: config.diarizationMinSpeakers,
          maxSpeakerCount: config.diarizationMaxSpeakers,
        },
      },
    },
    files: [{ uri: gcsUri }],
    recognitionOutputConfig: { inlineResponseConfig: {} },
  });

  const [response] = await operation.promise();
  const fileResult = (response.results as Record<string, any>)?.[gcsUri];
  const results = fileResult?.inlineResult?.transcript?.results || [];

  const words: DiarizedWord[] = results.flatMap((r: any) => r.alternatives?.[0]?.words || []);
  return wordsToSegments(sessionId, words);
}

/** Best-effort cleanup of a session's uploaded audio, if any — used when deleting a session. */
export async function deleteUploadedAudio(sessionId: string): Promise<void> {
  if (!config.gcsBucket) return;
  await storage
    .bucket(config.gcsBucket)
    .file(`sessions/${sessionId}.wav`)
    .delete({ ignoreNotFound: true });
}

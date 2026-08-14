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
 * batchRecognize (or the long-running operation it returns) occasionally
 * rejects a request with an opaque "Config contains unsupported fields"
 * INVALID_ARGUMENT shortly after uploading a new GCS object — this has been
 * seen to be transient GCS read-after-write propagation lag (reproducing the
 * exact same request against the exact same already-uploaded file moments
 * later succeeds). But it has ALSO been reproduced failing identically 5/5
 * retries in a row for a session recorded with languageCodes: ['ar-MA'] —
 * Chirp 3's documented Arabic support is via the broader 'ar-XA' locale, so
 * a narrower dialect-specific code like 'ar-MA' most likely isn't one Chirp
 * 3 recognizes for BatchRecognize+diarization at all, which the API reports
 * with this same generic message. The gRPC message never names the actual
 * unsupported field — err.statusDetails/err.metadata (the "error_details_ext"
 * it refers to) come back empty from this client library, so the two causes
 * can't be told apart programmatically; retry still cheaply absorbs the
 * transient case, and the final error message below covers the other one.
 */
async function batchRecognizeWithRetry(request: Parameters<typeof speechClient.batchRecognize>[0], attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const [operation] = await speechClient.batchRecognize(request);
      return await operation.promise();
    } catch (err: any) {
      const isUnsupportedFieldsError = err?.code === 3 && /unsupported fields/i.test(err?.message || '');
      if (attempt >= attempts || !isUnsupportedFieldsError) {
        if (isUnsupportedFieldsError) {
          const languageCodes = (request.config as any)?.languageCodes?.join(', ') || 'unknown';
          throw new Error(
            `Config contains unsupported fields (Google Speech-to-Text). This can be transient GCS propagation lag, but it can also mean the ${config.speechModel} model doesn't support diarization for this session's language code(s) (${languageCodes}) — some regional/dialect codes (e.g. a narrow Arabic dialect code instead of the broader 'ar-XA') aren't recognized. Try again in a moment, or re-check the session's language setting.`
          );
        }
        throw err;
      }
      console.warn(`[diarization] batchRecognize attempt ${attempt} hit the transient "unsupported fields" error, retrying:`, err.message);
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

  const [response] = await batchRecognizeWithRetry({
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

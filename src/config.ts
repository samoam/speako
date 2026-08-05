import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  gcpProjectId: required('GCP_PROJECT_ID'),
  speechLocation: process.env.GCP_SPEECH_LOCATION || 'us',
  speechModel: process.env.SPEECH_MODEL || 'chirp_3',
  languageCodes: (process.env.SPEECH_LANGUAGE_CODES || 'en-US').split(',').map((s) => s.trim()),

  micDevice: process.env.MIC_AUDIO_DEVICE || '',
  systemDevice: process.env.SYSTEM_AUDIO_DEVICE || '',
  /** Path to the sox executable. Defaults to relying on PATH; override to point at a local/bundled copy. */
  soxBinary: process.env.SOX_BINARY || 'sox',

  sampleRate: Number(process.env.SAMPLE_RATE || 16000),
  streamRestartSeconds: Number(process.env.STREAM_RESTART_SECONDS || 240),

  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'speako.db'),
  httpPort: Number(process.env.HTTP_PORT || 3000),

  /** GCS bucket for post-session diarization audio uploads. Diarization is skipped if unset. */
  gcsBucket: process.env.GCS_BUCKET || '',
  diarizationMinSpeakers: Number(process.env.DIARIZATION_MIN_SPEAKERS || 1),
  diarizationMaxSpeakers: Number(process.env.DIARIZATION_MAX_SPEAKERS || 6),
  audioDir: process.env.AUDIO_DIR || path.join(process.cwd(), 'data', 'audio'),

  /** Gemini API key for on-demand summarization/action-item extraction. Feature is skipped if unset. */
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',

  /** Versioned domain-vocabulary list biasing streaming recognition. See config/phrase-hints.json. */
  phraseHintsPath: process.env.PHRASE_HINTS_PATH || path.join(process.cwd(), 'config', 'phrase-hints.json'),

  /** Runs Cloud Natural Language sentiment analysis on each finalized live segment. Unlike diarization/summarization this runs automatically during recording — it's only the text of segments already shown live, and is required for the live tone-shift trigger to work at all. Set to "false" to disable. */
  sentimentEnabled: process.env.SENTIMENT_ENABLED !== 'false',

  /** Live trigger detection (Phase 3) — same automatic-during-recording rationale as sentiment. */
  triggerDetectionEnabled: process.env.TRIGGER_DETECTION_ENABLED !== 'false',
  triggerConfidenceThreshold: Number(process.env.TRIGGER_CONFIDENCE_THRESHOLD || 0.6),
  triggerCooldownMs: Number(process.env.TRIGGER_COOLDOWN_MS || 45_000),
  triggerRateLimitPerMinute: Number(process.env.TRIGGER_RATE_LIMIT_PER_MINUTE || 4),
  unansweredQuestionTimeoutMs: Number(process.env.UNANSWERED_QUESTION_TIMEOUT_MS || 20_000),
  toneShiftDelta: Number(process.env.TONE_SHIFT_DELTA || 0.5),

  /** RAG corpus: past sessions' transcripts, auto-indexed on stop (same rationale as sentiment/triggers — text already stored/shown, needed for the live suggestion feature to work). */
  ragEnabled: process.env.RAG_ENABLED !== 'false',
  ragEmbeddingModel: process.env.RAG_EMBEDDING_MODEL || 'gemini-embedding-001',
  ragTopK: Number(process.env.RAG_TOP_K || 3),
  ragSimilarityThreshold: Number(process.env.RAG_SIMILARITY_THRESHOLD || 0.65),

  /**
   * Bitbucket Server (self-hosted, Basic auth over REST — NOT Bitbucket Cloud).
   * No server-wide code search is available on this instance, so the
   * integration is scoped to specific project/repo slugs rather than
   * searching everything. Format: "PROJECT_KEY/repo-slug", comma-separated.
   * Feature is skipped if url/username/token or the repo list is unset.
   */
  bitbucketServerUrl: process.env.BITBUCKET_SERVER_URL || '',
  bitbucketServerUsername: process.env.BITBUCKET_SERVER_USERNAME || '',
  bitbucketServerToken: process.env.BITBUCKET_SERVER_TOKEN || '',
  bitbucketServerRepos: (process.env.BITBUCKET_SERVER_REPOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [project, repo] = s.split('/');
      return { project, repo };
    }),

  /** Jira (Phase 4 fact-check/Q&A source), queried via the existing `mcp-atlassian` MCP server (spawned locally) rather than direct REST. Feature is skipped if url/token are unset. */
  jiraUrl: process.env.JIRA_URL || '',
  jiraPersonalToken: process.env.JIRA_PERSONAL_TOKEN || '',

  /** Confluence (Phase 4 fact-check/Q&A source), also via `mcp-atlassian`. Feature is skipped if url/username/token are unset. */
  confluenceUrl: process.env.CONFLUENCE_URL || '',
  confluenceUsername: process.env.CONFLUENCE_USERNAME || '',
  confluenceApiToken: process.env.CONFLUENCE_API_TOKEN || '',

  /** Live in-meeting Q&A — same on-demand rationale as diarization/summarization (an explicit user action, not automatic). */
  liveQaEnabled: process.env.LIVE_QA_ENABLED !== 'false',

  /**
   * Improvements Phase §2: persistent meeting-state layer (rolling summary +
   * open-items registry), updated incrementally every N finalized segments
   * rather than per-segment (keeps the extra LLM call from becoming a live
   * latency bottleneck — same cadence-over-per-event rationale as trigger
   * detection's cooldown/rate-limit in Phase 3). Runs automatically during
   * recording, like sentiment/triggers/RAG, since suggestion/fact-check
   * quality depends on it being current.
   */
  meetingStateEnabled: process.env.MEETING_STATE_ENABLED !== 'false',
  meetingStateUpdateEverySegments: Number(process.env.MEETING_STATE_UPDATE_EVERY_SEGMENTS || 6),

  /**
   * Live audio waveform indicator — purely cosmetic (see
   * Improvement_LiveAudioWaveform.md), automatic during recording like
   * sentiment/triggers since its whole point is instant "is it actually
   * listening" feedback. Downsampled server-side (src/audio-capture/waveform.ts)
   * and broadcast over the existing WebSocket rather than streaming raw PCM
   * to the browser — no new dependency, no separate audio pipeline.
   */
  waveformEnabled: process.env.WAVEFORM_ENABLED !== 'false',
};

export type SpeakoConfig = typeof config;

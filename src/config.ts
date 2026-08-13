import * as dotenv from 'dotenv';
import * as path from 'path';
import { ToolKey } from './tools/activeTools';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Settings-page overrides for the "dynamic" fields below, populated by
// settingsStore.ts from the `settings` table. Kept here (rather than config.ts
// importing settingsStore) to avoid a config -> settingsStore -> db -> config
// import cycle — settingsStore pushes values in via _setConfigOverrides
// instead of config pulling them.
let overrides: Record<string, string> = {};

/** Internal — called only by settingsStore.ts. */
export function _setConfigOverrides(next: Record<string, string>): void {
  overrides = next;
}

function str(key: string, envVar: string, fallback: string): string {
  return overrides[key] ?? process.env[envVar] ?? fallback;
}

function num(key: string, envVar: string, fallback: number): number {
  const raw = overrides[key] ?? process.env[envVar];
  const n = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, envVar: string, fallback: boolean): boolean {
  const raw = overrides[key] ?? process.env[envVar];
  return raw === undefined ? fallback : raw !== 'false' && raw !== '0';
}

function parseCodebaseLocalPaths(raw: string): { name: string; path: string }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, ...rest] = s.split('=');
      return { name: name.trim(), path: rest.join('=').trim() };
    })
    .filter((p) => p.name && p.path);
}

function parseBitbucketServerRepos(raw: string): { project: string; repo: string }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [project, repo] = s.split('/');
      return { project, repo };
    });
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
  get diarizationMinSpeakers(): number {
    return num('diarizationMinSpeakers', 'DIARIZATION_MIN_SPEAKERS', 1);
  },
  get diarizationMaxSpeakers(): number {
    return num('diarizationMaxSpeakers', 'DIARIZATION_MAX_SPEAKERS', 6);
  },
  audioDir: process.env.AUDIO_DIR || path.join(process.cwd(), 'data', 'audio'),

  /** Gemini API key for on-demand summarization/action-item extraction. Feature is skipped if unset. */
  get geminiApiKey(): string {
    return str('geminiApiKey', 'GEMINI_API_KEY', '');
  },
  get geminiModel(): string {
    return str('geminiModel', 'GEMINI_MODEL', 'gemini-flash-latest');
  },
  /** Distinct from geminiModel — the Live API (voice chat/practice) requires a model that supports bidiGenerateContent, not a plain generateContent model. Confirmed available via ai.models.list() at the time this was set; if Google retires it, list models filtered on supportedActions.includes('bidiGenerateContent') to find the current name. */
  get geminiLiveModel(): string {
    return str('geminiLiveModel', 'GEMINI_LIVE_MODEL', 'gemini-2.5-flash-native-audio-latest');
  },
  /**
   * Cheaper/faster tier for high-frequency, mechanical calls (live trigger
   * classification, rolling-summary updates) where flash-lite's quality is
   * plenty — see docs/gemini-cost-optimization notes. Not used for
   * generative/creative calls (suggestions, summaries, prep briefs), which
   * stay on geminiModel.
   *
   * Uses the "-latest" alias, not a pinned version, for the same reason
   * geminiModel does (see its .env.example comment) — confirmed via direct
   * API testing that the previously-pinned "gemini-2.5-flash-lite" now 404s
   * ("no longer available to new users") despite still appearing in
   * ai.models.list(), so pinning a specific version here is exactly the trap
   * the alias is meant to avoid.
   */
  get geminiFastModel(): string {
    return str('geminiFastModel', 'GEMINI_FAST_MODEL', 'gemini-flash-lite-latest');
  },
  /**
   * Which tools voice chat/practice's function-calling is allowed to use —
   * user-configurable (Settings > Voice chat tools) subset of
   * liveVoiceSession.ts's VOICE_TOOL_KEYS ceiling. server.ts further filters
   * this down to whichever of the chosen tools are actually configured
   * (real credentials/paths present), so picking a tool here doesn't do
   * anything on its own if it's not set up elsewhere in Settings.
   * Comma-separated, e.g. "jira,confluence,mem0,ragCloud,bitbucket,localCodebase".
   */
  get voiceToolKeys(): ToolKey[] {
    const raw = str('voiceToolKeys', 'VOICE_TOOL_KEYS', 'jira,confluence,mem0,ragCloud,bitbucket,bitbucketReviews,localCodebase');
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as ToolKey[];
  },

  /** Versioned domain-vocabulary list biasing streaming recognition. See config/phrase-hints.json. */
  phraseHintsPath: process.env.PHRASE_HINTS_PATH || path.join(process.cwd(), 'config', 'phrase-hints.json'),

  /** Runs Cloud Natural Language sentiment analysis on each finalized live segment. Unlike diarization/summarization this runs automatically during recording — it's only the text of segments already shown live, and is required for the live tone-shift trigger to work at all. */
  get sentimentEnabled(): boolean {
    return bool('sentimentEnabled', 'SENTIMENT_ENABLED', true);
  },

  /** Live trigger detection (Phase 3) — same automatic-during-recording rationale as sentiment. */
  get triggerDetectionEnabled(): boolean {
    return bool('triggerDetectionEnabled', 'TRIGGER_DETECTION_ENABLED', true);
  },
  get triggerConfidenceThreshold(): number {
    return num('triggerConfidenceThreshold', 'TRIGGER_CONFIDENCE_THRESHOLD', 0.6);
  },
  get triggerCooldownMs(): number {
    return num('triggerCooldownMs', 'TRIGGER_COOLDOWN_MS', 45_000);
  },
  get triggerRateLimitPerMinute(): number {
    return num('triggerRateLimitPerMinute', 'TRIGGER_RATE_LIMIT_PER_MINUTE', 4);
  },
  get unansweredQuestionTimeoutMs(): number {
    return num('unansweredQuestionTimeoutMs', 'UNANSWERED_QUESTION_TIMEOUT_MS', 20_000);
  },
  get toneShiftDelta(): number {
    return num('toneShiftDelta', 'TONE_SHIFT_DELTA', 0.5);
  },

  /** RAG corpus: past sessions' transcripts, auto-indexed on stop (same rationale as sentiment/triggers — text already stored/shown, needed for the live suggestion feature to work). */
  get ragEnabled(): boolean {
    return bool('ragEnabled', 'RAG_ENABLED', true);
  },
  ragEmbeddingModel: process.env.RAG_EMBEDDING_MODEL || 'gemini-embedding-001',
  get ragTopK(): number {
    return num('ragTopK', 'RAG_TOP_K', 3);
  },
  get ragSimilarityThreshold(): number {
    return num('ragSimilarityThreshold', 'RAG_SIMILARITY_THRESHOLD', 0.65);
  },

  /**
   * Bitbucket Server (self-hosted, Basic auth over REST — NOT Bitbucket Cloud).
   * No server-wide code search is available on this instance, so the
   * integration is scoped to specific project/repo slugs rather than
   * searching everything. Format: "PROJECT_KEY/repo-slug", comma-separated.
   * Feature is skipped if url/username/token or the repo list is unset.
   */
  get bitbucketServerUrl(): string {
    return str('bitbucketServerUrl', 'BITBUCKET_SERVER_URL', '');
  },
  get bitbucketServerUsername(): string {
    return str('bitbucketServerUsername', 'BITBUCKET_SERVER_USERNAME', '');
  },
  get bitbucketServerToken(): string {
    return str('bitbucketServerToken', 'BITBUCKET_SERVER_TOKEN', '');
  },
  get bitbucketServerRepos(): { project: string; repo: string }[] {
    return parseBitbucketServerRepos(str('bitbucketServerRepos', 'BITBUCKET_SERVER_REPOS', ''));
  },

  /** Jira (Phase 4 fact-check/Q&A source), queried via the existing `mcp-atlassian` MCP server (spawned locally) rather than direct REST. Feature is skipped if url/token are unset. */
  get jiraUrl(): string {
    return str('jiraUrl', 'JIRA_URL', '');
  },
  get jiraPersonalToken(): string {
    return str('jiraPersonalToken', 'JIRA_PERSONAL_TOKEN', '');
  },

  /** Confluence (Phase 4 fact-check/Q&A source), also via `mcp-atlassian`. Feature is skipped if url/username/token are unset. */
  get confluenceUrl(): string {
    return str('confluenceUrl', 'CONFLUENCE_URL', '');
  },
  get confluenceUsername(): string {
    return str('confluenceUsername', 'CONFLUENCE_USERNAME', '');
  },
  get confluenceApiToken(): string {
    return str('confluenceApiToken', 'CONFLUENCE_API_TOKEN', '');
  },

  /** Live in-meeting Q&A — same on-demand rationale as diarization/summarization (an explicit user action, not automatic). */
  get liveQaEnabled(): boolean {
    return bool('liveQaEnabled', 'LIVE_QA_ENABLED', true);
  },

  /**
   * Live Q&A sends only the last N transcript segments as raw context,
   * relying on the rolling summary + open-items registry (meetingState.ts)
   * to carry everything earlier — otherwise the prompt grows linearly with
   * meeting length on every question asked. 40 segments is comfortably more
   * than the immediate exchange the summary wouldn't have caught up to yet.
   */
  get liveQaTranscriptWindowSegments(): number {
    return num('liveQaTranscriptWindowSegments', 'LIVE_QA_TRANSCRIPT_WINDOW_SEGMENTS', 40);
  },

  /**
   * Live API voice sessions (chat/practice) bill for as long as the
   * WebSocket to Gemini stays open — if a user starts one and walks away
   * without clicking Stop, it bills indefinitely. Safety net only: auto-closed
   * after this many ms with no mic audio/transcript activity.
   */
  get voiceSessionIdleTimeoutMs(): number {
    return num('voiceSessionIdleTimeoutMs', 'VOICE_SESSION_IDLE_TIMEOUT_MS', 5 * 60_000);
  },

  /**
   * Improvements Phase §2: persistent meeting-state layer (rolling summary +
   * open-items registry), updated incrementally every N finalized segments
   * rather than per-segment (keeps the extra LLM call from becoming a live
   * latency bottleneck — same cadence-over-per-event rationale as trigger
   * detection's cooldown/rate-limit in Phase 3). Runs automatically during
   * recording, like sentiment/triggers/RAG, since suggestion/fact-check
   * quality depends on it being current.
   */
  get meetingStateEnabled(): boolean {
    return bool('meetingStateEnabled', 'MEETING_STATE_ENABLED', true);
  },
  get meetingStateUpdateEverySegments(): number {
    return num('meetingStateUpdateEverySegments', 'MEETING_STATE_UPDATE_EVERY_SEGMENTS', 6);
  },

  /**
   * Live audio waveform indicator — purely cosmetic (see
   * Improvement_LiveAudioWaveform.md), automatic during recording like
   * sentiment/triggers since its whole point is instant "is it actually
   * listening" feedback. Downsampled server-side (src/audio-capture/waveform.ts)
   * and broadcast over the existing WebSocket rather than streaming raw PCM
   * to the browser — no new dependency, no separate audio pipeline.
   */
  get waveformEnabled(): boolean {
    return bool('waveformEnabled', 'WAVEFORM_ENABLED', true);
  },

  /**
   * mem0-cloud: durable cross-meeting facts (a remote Streamable-HTTP MCP
   * server, not a local subprocess like Jira/Confluence). Read during
   * one-on-one prep, written after a summary is generated. Feature is
   * skipped if url/key are unset.
   */
  get mem0McpUrl(): string {
    return str('mem0McpUrl', 'MEM0_MCP_URL', '');
  },
  get mem0McpApiKey(): string {
    return str('mem0McpApiKey', 'MEM0_MCP_API_KEY', '');
  },

  /**
   * rag-cloud (MyRAG): external reference ingestion (design docs, repos) for
   * design/dev-discussion prep. Same remote Streamable-HTTP MCP shape as
   * mem0-cloud above. Feature is skipped if url/key are unset.
   */
  get ragMcpUrl(): string {
    return str('ragMcpUrl', 'RAG_MCP_URL', '');
  },
  get ragMcpApiKey(): string {
    return str('ragMcpApiKey', 'RAG_MCP_API_KEY', '');
  },

  /**
   * Pre-meeting prep (type/subtype-driven context gathering before
   * recording starts). Master toggle for the whole feature; calendar
   * detection is a separate, independently-optional sub-feature below.
   */
  get prepEnabled(): boolean {
    return bool('prepEnabled', 'PREP_ENABLED', true);
  },

  /**
   * Google Calendar (OAuth "installed app" flow — run `npm run gcal-auth`
   * once to produce the token file). Purely additive: without it, work
   * sessions still work via manual meeting-type selection, just without
   * calendar-based auto-detection or the upcoming-meeting poller/shortcuts.
   */
  get googleCalendarCredentialsPath(): string {
    return str('googleCalendarCredentialsPath', 'GOOGLE_CALENDAR_CREDENTIALS_PATH', '');
  },
  get googleCalendarTokenPath(): string {
    return str('googleCalendarTokenPath', 'GOOGLE_CALENDAR_TOKEN_PATH', path.join(process.cwd(), 'data', 'gcal-token.json'));
  },
  get prepWindowMinutes(): number {
    return num('prepWindowMinutes', 'PREP_WINDOW_MINUTES', 15);
  },

  /**
   * Local codebase indexing for design/dev prep (src/codebase/) — chunks +
   * Gemini-embeds source files already checked out on this machine into a
   * local SQLite table (code_chunks), same pattern as the existing
   * past-meeting RAG corpus. Deliberately local-only: no remote cloning, no
   * credentials, source code never leaves this machine except for the text
   * sent to Gemini for embedding. Format: comma-separated "name=path" pairs,
   * e.g. "officercc=C:\Users\me\dev\officercc,other=C:\Users\me\dev\other".
   * Feature is skipped if unset.
   */
  get codebaseLocalPaths(): { name: string; path: string }[] {
    return parseCodebaseLocalPaths(str('codebaseLocalPaths', 'CODEBASE_LOCAL_PATHS', 'officercc=C:\\Users\\madadi\\git\\master'));
  },

  /**
   * Microsoft Graph (Outlook + Teams chats) — native ingestion, replacing the
   * need for the external daily-agent task described in
   * docs/EXTERNAL_INGESTION_PROMPT.md (still supported as a fallback for
   * anyone without Azure AD app-registration access). Auth is a public-client
   * device-code flow (one-time `npm run msgraph-auth`, see scripts/msgraph-auth.ts)
   * — no client secret, since a secret can't be safely held by a local desktop
   * app anyway. Feature is skipped if clientId is unset or the token cache
   * file doesn't exist yet (auth script hasn't been run).
   */
  get msGraphClientId(): string {
    return str('msGraphClientId', 'MS_GRAPH_CLIENT_ID', '');
  },
  /** 'common' allows both work/school and personal accounts to sign in; narrow to a specific tenant GUID if your org requires it. */
  get msGraphTenantId(): string {
    return str('msGraphTenantId', 'MS_GRAPH_TENANT_ID', 'common');
  },
  get msGraphTokenPath(): string {
    return str('msGraphTokenPath', 'MS_GRAPH_TOKEN_PATH', path.join(process.cwd(), 'data', 'msgraph-token.json'));
  },
  /** Background poll cadence — mirrors the scheduled-session/voice-idle timers' setInterval pattern in server.ts. */
  get msGraphPollMinutes(): number {
    return num('msGraphPollMinutes', 'MS_GRAPH_POLL_MINUTES', 15);
  },
  /**
   * How far back each sync run looks, regardless of when the last run
   * happened — deliberate overlap (not "since last sync") so a missed run
   * (app closed, token expired) can't silently create a gap; re-upserting an
   * already-seen message is harmless (see externalMessageRepository's
   * upsertExternalMessage, same ON CONFLICT semantics the external-agent doc
   * already specifies).
   */
  get msGraphLookbackHours(): number {
    return num('msGraphLookbackHours', 'MS_GRAPH_LOOKBACK_HOURS', 48);
  },

  /**
   * Classic-Outlook-desktop COM automation fallback (src/integrations/outlookDesktop.ts)
   * for mailboxes Microsoft Graph's cloud-only Mail API can't reach (hybrid/
   * on-premises Exchange, or accounts that turn out to be B2B guests rather
   * than native tenant members — both confirmed real blockers during setup,
   * see NOTES.md). Windows + classic Outlook only ("New Outlook" has no COM
   * automation support) — manually triggered only (Settings' "Sync via
   * Outlook desktop" button), not polled, since Outlook's Object Model Guard
   * can show an interactive security prompt on first use in a session.
   */
  get outlookDesktopLookbackHours(): number {
    return num('outlookDesktopLookbackHours', 'OUTLOOK_DESKTOP_LOOKBACK_HOURS', 48);
  },

  /**
   * Auto-creates a Speako session (with prep already running) for every
   * not-yet-started meeting in the current week's Outlook calendar — see
   * src/calendar/calendarImport.ts. Unlike outlookDesktopLookbackHours'
   * mail sync above, this IS polled unattended, so the same Object Model
   * Guard security-prompt risk noted there applies on first use in a
   * session; the export script's existing 60s timeout keeps a stuck prompt
   * from hanging the poll loop forever (see NOTES.md).
   */
  get calendarImportEnabled(): boolean {
    return bool('calendarImportEnabled', 'CALENDAR_IMPORT_ENABLED', true);
  },
  get calendarImportPollMinutes(): number {
    return num('calendarImportPollMinutes', 'CALENDAR_IMPORT_POLL_MINUTES', 15);
  },
};

export type SpeakoConfig = typeof config;

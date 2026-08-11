import express from 'express';
import * as http from 'http';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { TranscriptSegment } from '../types';
import {
  getSegmentsForSession,
  getSession,
  replaceSegmentsForSession,
  listSessions,
  renameSession,
  deleteSession,
  setActiveTools,
  setActiveFeatures,
  setScheduledStartAt,
  getDueScheduledSessions,
  endSession,
  insertFinalSegment,
} from '../storage/segmentRepository';
import { LiveVoiceSession, VOICE_TOOL_KEYS } from '../voice/liveVoiceSession';
import { buildChatInstruction, buildPracticeInstruction } from '../voice/systemInstructions';
import { diarizeSession, deleteUploadedAudio } from '../diarization/diarize';
import { SUPPORTED_LANGUAGES } from '../languages';
import { toPlainText } from '../transcriptFormat';
import { summarizeAndExtractActionItems } from '../summarization/summarize';
import {
  getSummary,
  getActionItems,
  getActionItem,
  setActionItemStatus,
  saveSummaryAndActionItems,
  Summary,
  ActionItem,
} from '../storage/summaryRepository';
import { getSentimentScoresForSession } from '../storage/sentimentRepository';
import { getTriggersForSession, getTrigger, updateTriggerSegmentText, TriggerEvent } from '../storage/triggerRepository';
import { getSuggestionsForSession, getSuggestion, setSuggestionAction, Suggestion } from '../storage/suggestionRepository';
import { getSurfacedFactChecksForSession, getFactChecksForSession, getFactCheck, setFactCheckAction, insertFactCheck, FactCheck } from '../storage/factCheckRepository';
import { getLiveQueriesForSession, insertLiveQuery, LiveQuery } from '../storage/liveQueryRepository';
import { answerLiveQuestion } from '../qa/liveQa';
import { factCheckClaim } from '../factcheck/factcheck';
import { createSession as createPrepSession } from '../storage/segmentRepository';
import { getPrepBrief, updatePrepBriefText } from '../storage/prepBriefRepository';
import { runPrep } from '../prep/PrepService';
import { MeetingType } from '../prep/meetingTypes';
import { listUpcomingEvents, isCalendarConfigured } from '../integrations/googleCalendar';
import { listUpcomingOutlookEvents } from '../integrations/outlookDesktopCalendar';
import { writeSummaryFactsToMem0 } from '../prep/writeMemFacts';
import { analyzeConversation } from '../coaching/analyzeConversation';
import { saveCoachingFeedback, getCoachingFeedback, CoachingFeedback } from '../storage/coachingRepository';
import { detectChapters } from '../summarization/chapters';
import { saveChapters, getChapters, MeetingChapters } from '../storage/chaptersRepository';
import { getTopicFrequencies } from '../insights/topicTrend';
import { getRelationshipTrend } from '../insights/relationshipTrend';
import { answerAcrossAllMeetings } from '../qa/crossSessionQa';
import { insertCrossSessionQuery, getCrossSessionQueryHistory } from '../storage/crossSessionQueryRepository';
import { runCodebaseIndex } from '../codebase/indexCodebase';
import { getIndexedRepoSummary } from '../storage/codeRepository';
import { updateSettings } from '../settingsStore';
import { ALL_TOOL_KEYS } from '../tools/activeTools';
import { ALL_FEATURE_KEYS, FEATURE_LABELS } from '../tools/activeFeatures';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { isJiraConfigured } from '../integrations/jiraMcp';
import { isConfluenceConfigured } from '../integrations/confluenceMcp';
import { isMem0Configured } from '../integrations/mem0Client';
import { isRagConfigured } from '../integrations/ragClient';
import { isLocalCodebaseConfigured } from '../codebase/indexCodebase';
import { isWebFactCheckConfigured } from '../factcheck/webFactCheck';
import { WORKFLOW_STEPS } from '../prep/workflows/workflowSteps';
import { runExternalMessageIndex } from '../communications/indexExternalMessages';
import { getExternalMessageIndexSummary, hasAnyExternalMessages } from '../storage/externalMessageRepository';
import { isMsGraphConfigured } from '../integrations/msGraphAuth';
import { syncOutlookAndTeams } from '../integrations/msGraphSync';
import { isOutlookDesktopConfigured, syncOutlookDesktop } from '../integrations/outlookDesktop';

const SETTINGS_FIELDS = [
  'geminiApiKey',
  'geminiModel',
  'geminiLiveModel',
  'geminiFastModel',
  'jiraUrl',
  'jiraPersonalToken',
  'confluenceUrl',
  'confluenceUsername',
  'confluenceApiToken',
  'bitbucketServerUrl',
  'bitbucketServerUsername',
  'bitbucketServerToken',
  'bitbucketServerRepos',
  'mem0McpUrl',
  'mem0McpApiKey',
  'ragMcpUrl',
  'ragMcpApiKey',
  'googleCalendarCredentialsPath',
  'googleCalendarTokenPath',
  'prepWindowMinutes',
  'codebaseLocalPaths',
  'voiceToolKeys',
  'msGraphClientId',
  'msGraphTenantId',
  'msGraphPollMinutes',
  'msGraphLookbackHours',
  'outlookDesktopLookbackHours',
  'prepEnabled',
  'sentimentEnabled',
  'triggerDetectionEnabled',
  'triggerConfidenceThreshold',
  'triggerCooldownMs',
  'triggerRateLimitPerMinute',
  'unansweredQuestionTimeoutMs',
  'toneShiftDelta',
  'ragEnabled',
  'ragTopK',
  'ragSimilarityThreshold',
  'liveQaEnabled',
  'meetingStateEnabled',
  'meetingStateUpdateEverySegments',
  'waveformEnabled',
  'diarizationMinSpeakers',
  'diarizationMaxSpeakers',
] as const;

/** Serializes a dynamic config field back to the flat string shape settings are stored/edited as. */
function serializeSettingValue(key: (typeof SETTINGS_FIELDS)[number]): string {
  const value = (config as any)[key];
  if (key === 'codebaseLocalPaths') {
    return (value as { name: string; path: string }[]).map((p) => `${p.name}=${p.path}`).join(',');
  }
  if (key === 'bitbucketServerRepos') {
    return (value as { project: string; repo: string }[]).map((r) => `${r.project}/${r.repo}`).join(',');
  }
  return String(value);
}

type StartHandler = (languageCode?: string, name?: string, existingSessionId?: string, activeFeatures?: string[] | null) => string;
type StopHandler = () => void;

export class InterfaceServer {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private currentSessionId: string | null = null;
  private onStartHandler: StartHandler | null = null;
  private onStopHandler: StopHandler | null = null;
  /** Voice (chat/practice) is per-client, unlike currentSessionId's single-global-recording model — each connected browser tab can have at most one active Live session. */
  private voiceSessions = new Map<
    WebSocket,
    {
      session: LiveVoiceSession;
      /** Set for both 'practice' and 'chat' modes — both persist a real session + transcript now, so they show up in the sidebar's Practice/Chat history tabs. */
      persistedSessionId?: string;
      persistedSessionKind?: 'practice' | 'chat';
      flushTranscript?: () => void;
      lastActivityAt: number;
    }
  >();
  private codebaseIndexInProgress = false;
  private communicationsIndexInProgress = false;
  private msGraphSyncInProgress = false;
  private msGraphLastSyncAt: string | null = null;
  private msGraphLastError: string | null = null;
  private outlookDesktopSyncInProgress = false;
  private outlookDesktopLastSyncAt: string | null = null;
  private outlookDesktopLastError: string | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private voiceIdleCheckTimer: NodeJS.Timeout | null = null;
  private msGraphSyncTimer: NodeJS.Timeout | null = null;

  constructor() {
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/status', (_req, res) => {
      res.json({ recording: !!this.currentSessionId, sessionId: this.currentSessionId });
    });

    app.get('/api/languages', (_req, res) => {
      res.json(SUPPORTED_LANGUAGES);
    });

    // Settings page: current effective value of every dynamic config field
    // (whether sourced from a DB override or an .env fallback — not
    // distinguished here). PUT persists a flat {key: string} patch; an empty
    // string for a key clears its override, falling back to .env/default.
    app.get('/api/settings', (_req, res) => {
      const settings: Record<string, string> = {};
      for (const key of SETTINGS_FIELDS) settings[key] = serializeSettingValue(key);
      res.json(settings);
    });

    app.put('/api/settings', (req, res) => {
      const patch: Record<string, string> = {};
      for (const key of SETTINGS_FIELDS) {
        if (typeof req.body?.[key] === 'string') patch[key] = req.body[key];
      }
      updateSettings(patch);
      res.json({ saved: true });
    });

    // Which tools are globally configured — used by the new-session/tools
    // pickers to grey out toggles that would do nothing if enabled.
    app.get('/api/tools', (_req, res) => {
      res.json({
        jira: isJiraConfigured(),
        confluence: isConfluenceConfigured(),
        bitbucket: isBitbucketConfigured(),
        bitbucketReviews: isBitbucketConfigured(),
        mem0: isMem0Configured(),
        ragCloud: isRagConfigured(),
        localCodebase: isLocalCodebaseConfigured(),
        webSearch: isWebFactCheckConfigured(),
        email: hasAnyExternalMessages('email'),
        teams: hasAnyExternalMessages('teams'),
      });
    });

    // Which heavy pipeline features are globally enabled (config.*Enabled) —
    // a per-session toggle can only ever turn one of these OFF for a session,
    // never on if it's globally disabled, so the UI only offers what could
    // actually apply, same rationale as /api/tools above.
    app.get('/api/features', (_req, res) => {
      res.json({
        sentiment: { enabled: config.sentimentEnabled, label: FEATURE_LABELS.sentiment },
        triggers: { enabled: config.triggerDetectionEnabled, label: FEATURE_LABELS.triggers },
        rag: { enabled: config.ragEnabled, label: FEATURE_LABELS.rag },
        meetingState: { enabled: config.meetingStateEnabled, label: FEATURE_LABELS.meetingState },
      });
    });

    // Rides the topic tags already produced by on-demand summarization
    // (SUMMARY_SCHEMA's `topics` field) — no separate Gemini call.
    app.get('/api/insights/topics', (_req, res) => {
      res.json(getTopicFrequencies());
    });

    app.get('/api/insights/ask/history', (_req, res) => {
      res.json(getCrossSessionQueryHistory());
    });

    // "Ask across all my meetings" — synchronous/awaited, same shape as the
    // existing per-session /ask route (the answer comes back in the response
    // itself, not a two-phase started/broadcast like summarize).
    app.post('/api/insights/ask', async (req, res) => {
      if (!config.geminiApiKey) {
        res.status(400).json({ error: 'GEMINI_API_KEY is not configured — see NOTES.md.' });
        return;
      }
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      if (!question) {
        res.status(400).json({ error: 'A question is required.' });
        return;
      }
      try {
        const answer = await answerAcrossAllMeetings(question);
        const query = insertCrossSessionQuery({ questionText: question, answerText: answer.answerText, sourcesUsed: answer.sourcesUsed });
        res.json(query);
      } catch (err: any) {
        console.error('[insights] cross-session ask failed:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // Describes what each meeting type's prep workflow gathers — shown in the
    // new-session UI so picking a type isn't a guess.
    app.get('/api/prep/workflow-steps', (_req, res) => {
      res.json(WORKFLOW_STEPS);
    });

    app.post('/api/session/start', (req, res) => {
      if (this.currentSessionId) {
        res.json({ sessionId: this.currentSessionId, alreadyRunning: true });
        return;
      }
      if (!this.onStartHandler) {
        res.status(500).json({ error: 'Server not ready to start a session.' });
        return;
      }
      const languageCode = typeof req.body?.languageCode === 'string' ? req.body.languageCode : undefined;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : undefined;
      const existingSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;
      // Only meaningful for a brand-new (non-resumed) session — a resumed
      // session created via /api/session/prepare already has its features
      // stored on the row from prepare-time.
      const activeFeatures = Array.isArray(req.body?.activeFeatures)
        ? req.body.activeFeatures.filter((f: unknown) => typeof f === 'string' && ALL_FEATURE_KEYS.includes(f as any))
        : null;
      const sessionId = this.onStartHandler(languageCode, name, existingSessionId, activeFeatures);
      res.json({ sessionId });
    });

    // Pre-meeting prep: creates the session row up front (session_type='work',
    // prep_status='pending') and kicks off PrepService async — recording can
    // start (via POST /api/session/start with this sessionId) at any point,
    // it's never blocked on prep finishing (§7 latency note: surface
    // "preparing" state, don't gate the record button on it).
    app.post('/api/session/prepare', (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : undefined;
      const meetingType = (typeof req.body?.meetingType === 'string' ? req.body.meetingType : 'generic') as MeetingType;
      const calendarEventId = typeof req.body?.calendarEventId === 'string' ? req.body.calendarEventId : undefined;
      const languageCodes = typeof req.body?.languageCode === 'string' ? [req.body.languageCode] : config.languageCodes;
      const userNotes = typeof req.body?.userNotes === 'string' ? req.body.userNotes.trim().slice(0, 4000) : undefined;
      const activeTools = Array.isArray(req.body?.activeTools)
        ? req.body.activeTools.filter((t: unknown) => typeof t === 'string' && ALL_TOOL_KEYS.includes(t as any))
        : undefined;
      const activeFeatures = Array.isArray(req.body?.activeFeatures)
        ? req.body.activeFeatures.filter((f: unknown) => typeof f === 'string' && ALL_FEATURE_KEYS.includes(f as any))
        : undefined;
      const scheduledStartAt = typeof req.body?.scheduledStartAt === 'string' ? req.body.scheduledStartAt : undefined;

      const sessionId = uuid();
      createPrepSession(sessionId, languageCodes, name, {
        sessionType: 'work',
        meetingType,
        calendarEventId,
        activeTools,
        activeFeatures,
        scheduledStartAt,
      });

      runPrep({
        sessionId,
        sessionName: name,
        meetingType,
        calendarEventId,
        userNotes,
        activeTools: activeTools ?? null,
        onDone: (id, status) => this.broadcast({ type: 'prep-ready', sessionId: id, status }),
      }).catch((err: any) => console.error(`[prep] unexpected failure for session ${sessionId}:`, err.message));

      res.json({ sessionId });
    });

    // Editable anytime, independent of prep — affects live fact-checking going
    // forward but doesn't retroactively change an already-generated prep brief.
    app.patch('/api/sessions/:id/tools', (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      const activeTools = Array.isArray(req.body?.activeTools)
        ? req.body.activeTools.filter((t: unknown) => typeof t === 'string' && ALL_TOOL_KEYS.includes(t as any))
        : [];
      setActiveTools(sessionId, activeTools);
      this.broadcast({ type: 'session-tools-updated', sessionId, activeTools });
      res.json({ sessionId, activeTools });
    });

    // Editable anytime, same rationale as the tools endpoint above — a
    // session already in progress can still have sentiment/triggers/RAG/
    // meeting-state turned off (or back on) going forward.
    app.patch('/api/sessions/:id/features', (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      const activeFeatures = Array.isArray(req.body?.activeFeatures)
        ? req.body.activeFeatures.filter((f: unknown) => typeof f === 'string' && ALL_FEATURE_KEYS.includes(f as any))
        : [];
      setActiveFeatures(sessionId, activeFeatures);
      this.broadcast({ type: 'session-features-updated', sessionId, activeFeatures });
      res.json({ sessionId, activeFeatures });
    });

    // Set (or, with null, cancel) when a not-yet-started session should auto-start
    // recording — see checkScheduledSessions() below. Editable/cancelable anytime
    // before the session actually starts; Session.start() clears it once it does.
    app.patch('/api/sessions/:id/schedule', (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      const scheduledStartAt = typeof req.body?.scheduledStartAt === 'string' ? req.body.scheduledStartAt : null;
      setScheduledStartAt(sessionId, scheduledStartAt);
      this.broadcast({ type: 'session-schedule-updated', sessionId, scheduledStartAt });
      res.json({ sessionId, scheduledStartAt });
    });

    app.get('/api/sessions/:id/prep-brief', (req, res) => {
      const brief = getPrepBrief(req.params.id);
      if (!brief) {
        res.status(404).json({ error: 'No prep brief for this session.' });
        return;
      }
      res.json(brief);
    });

    app.patch('/api/sessions/:id/prep-brief', (req, res) => {
      const sessionId = req.params.id;
      if (!getPrepBrief(sessionId)) {
        res.status(404).json({ error: 'No prep brief for this session.' });
        return;
      }
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      updatePrepBriefText(sessionId, text);
      res.json({ sessionId, text });
    });

    // Never errors on missing calendar config — empty list is the correct
    // "not set up" response, matching every other optional integration.
    // Google Calendar first if configured; Outlook desktop COM automation as
    // a fallback (its own separate integration, not merged/deduped with
    // Google's events — see NOTES.md) for calendars Google can't see at all.
    app.get('/api/calendar/upcoming', async (_req, res) => {
      try {
        const events = isCalendarConfigured()
          ? await listUpcomingEvents(config.prepWindowMinutes)
          : await listUpcomingOutlookEvents(config.prepWindowMinutes);
        res.json(events);
      } catch (err: any) {
        console.error('[calendar] failed to list upcoming events:', err.message);
        res.json([]);
      }
    });

    // Reindexes the whole configured codebase (src/codebase/) — a standalone
    // action independent of any single session, unlike prep's per-meeting sources.
    app.post('/api/codebase/index', (_req, res) => {
      if (this.codebaseIndexInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.codebaseIndexInProgress = true;
      runCodebaseIndex((p) => this.broadcast({ type: 'codebase-index-progress', ...p }))
        .catch((err: any) => console.error('[codebase] unexpected indexing failure:', err.message))
        .finally(() => {
          this.codebaseIndexInProgress = false;
          this.broadcast({ type: 'codebase-index-complete', repos: getIndexedRepoSummary() });
        });
      res.json({ started: true });
    });

    app.get('/api/codebase/status', (_req, res) => {
      res.json({ inProgress: this.codebaseIndexInProgress, repos: getIndexedRepoSummary() });
    });

    // Chunks + embeds whatever the external daily-indexing task has written
    // to external_messages since the last run (see
    // docs/EXTERNAL_INGESTION_PROMPT.md) — Speako never fetches email/Teams
    // itself, only processes what's already been written locally.
    app.post('/api/communications/index', (_req, res) => {
      if (this.communicationsIndexInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.communicationsIndexInProgress = true;
      runExternalMessageIndex((p) => this.broadcast({ type: 'communications-index-progress', ...p }))
        .catch((err: any) => console.error('[communications] unexpected indexing failure:', err.message))
        .finally(() => {
          this.communicationsIndexInProgress = false;
          this.broadcast({ type: 'communications-index-complete', sources: getExternalMessageIndexSummary() });
        });
      res.json({ started: true });
    });

    app.get('/api/communications/status', (_req, res) => {
      res.json({ inProgress: this.communicationsIndexInProgress, sources: getExternalMessageIndexSummary() });
    });

    // Native Outlook/Teams ingestion (Microsoft Graph) — writes raw rows into
    // the same external_messages table the manual daily-agent path
    // (docs/EXTERNAL_INGESTION_PROMPT.md) writes to; a separate background
    // timer (see start()) also calls this automatically every
    // config.msGraphPollMinutes when configured. This route lets Settings'
    // "Sync now" button trigger an out-of-cadence run the same way "Index
    // codebase"/"Index communications" do.
    app.post('/api/msgraph/sync', (_req, res) => {
      if (!isMsGraphConfigured()) {
        res.status(400).json({ error: 'Microsoft Graph is not configured — run `npm run msgraph-auth` first.' });
        return;
      }
      if (this.msGraphSyncInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runMsGraphSync();
      res.json({ started: true });
    });

    app.get('/api/msgraph/status', (_req, res) => {
      res.json({
        configured: isMsGraphConfigured(),
        inProgress: this.msGraphSyncInProgress,
        lastSyncAt: this.msGraphLastSyncAt,
        lastError: this.msGraphLastError,
      });
    });

    // Classic-Outlook-desktop COM automation fallback — see
    // src/integrations/outlookDesktop.ts's comment for why this exists
    // alongside the Graph sync above (hybrid/on-prem mailboxes and B2B-guest
    // identities can't be reached via Graph's cloud-only Mail API). Manual
    // only, no background timer — Outlook's Object Model Guard can show an
    // interactive security prompt on first use in a session, so an
    // unattended poll could silently stall behind it.
    app.post('/api/outlook-desktop/sync', (_req, res) => {
      if (!isOutlookDesktopConfigured()) {
        res.status(400).json({ error: 'Outlook desktop sync is only available on Windows.' });
        return;
      }
      if (this.outlookDesktopSyncInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.outlookDesktopSyncInProgress = true;
      syncOutlookDesktop()
        .then((result) => {
          this.outlookDesktopLastSyncAt = new Date().toISOString();
          this.outlookDesktopLastError = null;
          console.log(`[outlook-desktop] synced ${result.emailCount} email(s)`);
        })
        .catch((err: any) => {
          this.outlookDesktopLastError = err.message;
          console.error('[outlook-desktop] sync failed:', err.message);
        })
        .finally(() => {
          this.outlookDesktopSyncInProgress = false;
        });
      res.json({ started: true });
    });

    app.get('/api/outlook-desktop/status', (_req, res) => {
      res.json({
        configured: isOutlookDesktopConfigured(),
        inProgress: this.outlookDesktopSyncInProgress,
        lastSyncAt: this.outlookDesktopLastSyncAt,
        lastError: this.outlookDesktopLastError,
      });
    });

    app.post('/api/session/stop', (_req, res) => {
      if (!this.currentSessionId) {
        res.json({ stopped: false });
        return;
      }
      const stoppedId = this.currentSessionId;
      this.onStopHandler?.();
      this.currentSessionId = null;
      this.broadcast({ type: 'session-stop', sessionId: stoppedId });
      res.json({ stopped: true, sessionId: stoppedId });
    });

    app.get('/api/sessions', (_req, res) => {
      res.json(listSessions());
    });

    app.get('/api/sessions/:id/segments', (req, res) => {
      res.json(getSegmentsForSession(req.params.id));
    });

    app.patch('/api/sessions/:id/name', (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '';
      renameSession(sessionId, name);
      this.broadcast({ type: 'session-renamed', sessionId, name: name || null });
      res.json({ sessionId, name: name || null });
    });

    // On-demand only — audio is never uploaded/diarized automatically. Runs in
    // the background; progress/result arrive over the WebSocket.
    app.post('/api/sessions/:id/diarize', (req, res) => {
      const sessionId = req.params.id;
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (!session.endedAt) {
        res.status(409).json({ error: 'Session is still recording — stop it first.' });
        return;
      }
      if (!config.gcsBucket) {
        res.status(400).json({ error: 'GCS_BUCKET is not configured — see NOTES.md.' });
        return;
      }
      const wavPath = path.join(config.audioDir, `${sessionId}.wav`);
      if (!fs.existsSync(wavPath)) {
        res.status(409).json({ error: 'Recording not ready yet — try again in a moment.' });
        return;
      }

      res.json({ started: true });
      this.broadcastDiarizing(sessionId);
      diarizeSession(sessionId, wavPath, session.languageCodes)
        .then((segments) => {
          replaceSegmentsForSession(sessionId, segments);
          this.broadcastDiarized(sessionId, segments);
        })
        .catch((err: any) => {
          console.error('[diarization] failed:', err.message);
          this.broadcastDiarizationFailed(sessionId, err.message);
        });
    });

    app.get('/api/sessions/:id/summary', (req, res) => {
      const sessionId = req.params.id;
      res.json({ summary: getSummary(sessionId) || null, actionItems: getActionItems(sessionId) });
    });

    // On-demand only — nothing is sent to Gemini automatically. Runs in the
    // background; progress/result arrive over the WebSocket.
    app.post('/api/sessions/:id/summarize', (req, res) => {
      const sessionId = req.params.id;
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (!session.endedAt) {
        res.status(409).json({ error: 'Session is still recording — stop it first.' });
        return;
      }
      if (!config.geminiApiKey) {
        res.status(400).json({ error: 'GEMINI_API_KEY is not configured — see NOTES.md.' });
        return;
      }
      const segments = getSegmentsForSession(sessionId);
      if (segments.length === 0) {
        res.status(409).json({ error: 'No transcript to summarize.' });
        return;
      }

      res.json({ started: true });
      this.broadcastSummarizing(sessionId);
      summarizeAndExtractActionItems(segments)
        .then(([summary, actionItems]) => {
          saveSummaryAndActionItems(sessionId, summary, actionItems);
          this.broadcastSummarized(sessionId, getSummary(sessionId)!, getActionItems(sessionId));
          writeSummaryFactsToMem0(session.name, getSummary(sessionId)!, getActionItems(sessionId)).catch(() => {});
        })
        .catch((err: any) => {
          console.error('[summarization] failed:', err.message);
          this.broadcastSummarizationFailed(sessionId, err.message);
        });
    });

    app.get('/api/sessions/:id/coaching', (req, res) => {
      res.json({ feedback: getCoachingFeedback(req.params.id) || null });
    });

    // On-demand only, same shape as /summarize — a reflective analysis, not
    // something that improves live suggestion quality, so it's never automatic.
    app.post('/api/sessions/:id/coach', (req, res) => {
      const sessionId = req.params.id;
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (!session.endedAt) {
        res.status(409).json({ error: 'Session is still recording — stop it first.' });
        return;
      }
      if (!config.geminiApiKey) {
        res.status(400).json({ error: 'GEMINI_API_KEY is not configured — see NOTES.md.' });
        return;
      }
      const segments = getSegmentsForSession(sessionId);
      if (segments.length === 0) {
        res.status(409).json({ error: 'No transcript to analyze.' });
        return;
      }

      res.json({ started: true });
      analyzeConversation(sessionId)
        .then((analyzed) => {
          if (!analyzed) {
            this.broadcastCoachingFailed(sessionId, 'No "You" speech found to analyze in this transcript.');
            return;
          }
          const feedback = saveCoachingFeedback(sessionId, analyzed);
          this.broadcastCoaching(sessionId, feedback);
        })
        .catch((err: any) => {
          console.error('[coaching] failed:', err.message);
          this.broadcastCoachingFailed(sessionId, err.message);
        });
    });

    app.get('/api/sessions/:id/chapters', (req, res) => {
      res.json({ chapters: getChapters(req.params.id) || null });
    });

    // Deterministic, no Gemini call — empty array for anything that isn't a
    // named one-on-one session (see getRelationshipTrend).
    app.get('/api/sessions/:id/relationship-trend', (req, res) => {
      res.json(getRelationshipTrend(req.params.id));
    });

    // On-demand only, same shape as /summarize and /coach.
    app.post('/api/sessions/:id/chapters', (req, res) => {
      const sessionId = req.params.id;
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (!session.endedAt) {
        res.status(409).json({ error: 'Session is still recording — stop it first.' });
        return;
      }
      if (!config.geminiApiKey) {
        res.status(400).json({ error: 'GEMINI_API_KEY is not configured — see NOTES.md.' });
        return;
      }
      const segments = getSegmentsForSession(sessionId);
      if (segments.length === 0) {
        res.status(409).json({ error: 'No transcript to split into chapters.' });
        return;
      }

      res.json({ started: true });
      this.broadcastChaptersDetecting(sessionId);
      detectChapters(segments)
        .then((chapters) => {
          const saved = saveChapters(sessionId, chapters);
          this.broadcastChaptersDetected(sessionId, saved);
        })
        .catch((err: any) => {
          console.error('[chapters] detection failed:', err.message);
          this.broadcastChaptersDetectionFailed(sessionId, err.message);
        });
    });

    app.patch('/api/action-items/:id', (req, res) => {
      const id = Number(req.params.id);
      const item = getActionItem(id);
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      const status = req.body?.status === 'done' ? 'done' : 'open';
      setActionItemStatus(id, status);
      const updated = getActionItem(id)!;
      this.broadcast({ type: 'action-item-updated', sessionId: item.sessionId, actionItem: updated });
      res.json(updated);
    });

    app.delete('/api/sessions/:id', async (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (sessionId === this.currentSessionId) {
        res.status(409).json({ error: 'Session is still recording — stop it first.' });
        return;
      }

      const wavPath = path.join(config.audioDir, `${sessionId}.wav`);
      fs.rm(wavPath, { force: true }, (err) => {
        if (err) console.error('[delete] failed to remove local audio file:', err.message);
      });
      try {
        await deleteUploadedAudio(sessionId);
      } catch (err: any) {
        console.error('[delete] failed to remove uploaded audio:', err.message);
      }

      deleteSession(sessionId);
      this.broadcast({ type: 'session-deleted', sessionId });
      res.json({ deleted: true, sessionId });
    });

    app.get('/api/sessions/:id/sentiment', (req, res) => {
      res.json(getSentimentScoresForSession(req.params.id));
    });

    app.get('/api/sessions/:id/triggers', (req, res) => {
      const triggers = getTriggersForSession(req.params.id);
      const factChecksByTrigger = new Map<number, FactCheck>();
      for (const fc of getFactChecksForSession(req.params.id)) {
        if (fc.triggerId != null) factChecksByTrigger.set(fc.triggerId, fc);
      }
      res.json(triggers.map((t) => ({ ...t, factCheck: factChecksByTrigger.get(t.id) ?? null })));
    });

    app.get('/api/sessions/:id/suggestions', (req, res) => {
      res.json(getSuggestionsForSession(req.params.id));
    });

    app.patch('/api/suggestions/:id', (req, res) => {
      const id = Number(req.params.id);
      const suggestion = getSuggestion(id);
      if (!suggestion) {
        res.status(404).json({ error: 'Unknown suggestion.' });
        return;
      }
      const action = req.body?.action === 'accepted' ? 'accepted' : 'dismissed';
      setSuggestionAction(id, action);
      const updated = getSuggestion(id)!;
      this.broadcast({ type: 'suggestion-updated', sessionId: suggestion.sessionId, suggestion: updated });
      res.json(updated);
    });

    app.get('/api/sessions/:id/fact-checks', (req, res) => {
      res.json(getSurfacedFactChecksForSession(req.params.id));
    });

    app.patch('/api/fact-checks/:id', (req, res) => {
      const id = Number(req.params.id);
      const factCheck = getFactCheck(id);
      if (!factCheck) {
        res.status(404).json({ error: 'Unknown fact-check.' });
        return;
      }
      const action = req.body?.action === 'accepted' ? 'accepted' : 'dismissed';
      setFactCheckAction(id, action);
      const updated = getFactCheck(id)!;
      this.broadcast({ type: 'fact-check-updated', sessionId: factCheck.sessionId, factCheck: updated });
      res.json(updated);
    });

    // Lets a transcription typo be fixed before re-running the fact-check —
    // acknowledges immediately and streams the outcome back over the
    // trigger-fact-check WS message (same path the original live check uses),
    // rather than blocking the response on a Bitbucket/Jira/Confluence/web round trip.
    app.post('/api/triggers/:id/recheck', (req, res) => {
      const id = Number(req.params.id);
      const trigger = getTrigger(id);
      if (!trigger) {
        res.status(404).json({ error: 'Unknown trigger.' });
        return;
      }
      const editedText = typeof req.body?.claimText === 'string' ? req.body.claimText.trim() : '';
      const claimText = editedText || trigger.segmentText;
      if (!claimText) {
        res.status(400).json({ error: 'No claim text available to check.' });
        return;
      }
      if (editedText && editedText !== trigger.segmentText) {
        updateTriggerSegmentText(id, editedText);
      }

      res.json({ status: 'checking' });
      this.broadcastTriggerFactCheck(trigger.sessionId, id, 'pending', null);

      factCheckClaim(claimText, trigger.sessionId)
        .then((outcome) => {
          if (!outcome) {
            this.broadcastTriggerFactCheck(trigger.sessionId, id, 'skipped', null);
            return;
          }
          const surfaced = outcome.result === 'conflict';
          const factCheck = insertFactCheck({
            sessionId: trigger.sessionId,
            triggerId: id,
            claimText,
            sourceQueried: outcome.sourceQueried,
            groundTruth: outcome.groundTruth,
            result: outcome.result,
            surfaced,
          });
          this.broadcastTriggerFactCheck(trigger.sessionId, id, 'checked', factCheck);
          if (surfaced) this.broadcastFactCheck(factCheck);
        })
        .catch((err: any) => {
          console.error(`[factcheck] recheck failed for trigger ${id}:`, err.message);
          this.broadcastTriggerFactCheck(trigger.sessionId, id, 'error', null);
        });
    });

    app.get('/api/sessions/:id/queries', (req, res) => {
      res.json(getLiveQueriesForSession(req.params.id));
    });

    // Live Q&A stays on-demand (an explicit question you asked), unlike sentiment/triggers/RAG.
    app.post('/api/sessions/:id/ask', async (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (!config.liveQaEnabled || !config.geminiApiKey) {
        res.status(400).json({ error: 'Live Q&A is not configured — see NOTES.md.' });
        return;
      }
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      if (!question) {
        res.status(400).json({ error: 'A question is required.' });
        return;
      }

      try {
        const segments = getSegmentsForSession(sessionId);
        const answer = await answerLiveQuestion(sessionId, question, segments);
        const query = insertLiveQuery({
          sessionId,
          questionText: question,
          answerText: answer.answerText,
          sourcesUsed: answer.sourcesUsed,
        });
        this.broadcastLiveQuery(query);
        res.json(query);
      } catch (err: any) {
        console.error('[live-qa] failed:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/sessions/:id/export', (req, res) => {
      const segments = getSegmentsForSession(req.params.id);
      const asJson = req.query.format === 'json';
      const filename = `speako-${req.params.id}.${asJson ? 'json' : 'txt'}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (asJson) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(JSON.stringify(segments, null, 2));
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(toPlainText(segments));
      }
    });

    this.httpServer = http.createServer(app);
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (client) => {
      client.send(JSON.stringify({ type: 'status', recording: !!this.currentSessionId, sessionId: this.currentSessionId }));

      // Voice chat/practice reuses this same connection rather than opening a
      // second one — ws's message event already distinguishes binary frames
      // (mic audio, forwarded to this client's Live session) from the
      // existing JSON text frames (control messages / broadcasts), so both
      // coexist with no protocol conflict.
      client.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          const state = this.voiceSessions.get(client);
          if (state) {
            state.session.sendAudio(data);
            state.lastActivityAt = Date.now();
          }
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === 'voice-start') {
          this.startVoiceSession(client, msg.mode, msg.sourceSessionId).catch((err: any) => {
            console.error('[voice] failed to start session:', err.message);
            client.send(JSON.stringify({ type: 'voice-error', error: err.message }));
          });
        } else if (msg.type === 'voice-stop') {
          this.stopVoiceSession(client);
        } else if (msg.type === 'voice-text' && typeof msg.text === 'string' && msg.text.trim()) {
          const state = this.voiceSessions.get(client);
          if (state) {
            state.session.sendText(msg.text.trim());
            state.lastActivityAt = Date.now();
          }
        }
      });

      client.on('close', () => this.stopVoiceSession(client));
    });
  }

  /** mode 'practice': creates a new session (grounded by sourceSessionId's prep brief) so the roleplay gets full history + real coaching feedback afterward, same as any real meeting. mode 'chat': also creates a real session now (session_kind='chat'), so it shows up in the sidebar's Chat history tab — no coaching analysis, since it's not a roleplay run. */
  private async startVoiceSession(client: WebSocket, mode: 'chat' | 'practice', sourceSessionId?: string): Promise<void> {
    if (this.voiceSessions.has(client)) return;
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

    // config.voiceToolKeys (user's choice, Settings > Voice chat tools) is
    // filtered down to whichever of those are actually configured — picking
    // a tool here does nothing on its own if it has no real credentials/path.
    const configuredTools = config.voiceToolKeys.filter((tool) => {
      if (!VOICE_TOOL_KEYS.includes(tool)) return false; // ignore anything outside the eligible ceiling (stale setting, manual edit, etc.)
      switch (tool) {
        case 'jira':
          return isJiraConfigured();
        case 'confluence':
          return isConfluenceConfigured();
        case 'mem0':
          return isMem0Configured();
        case 'ragCloud':
          return isRagConfigured();
        case 'bitbucket':
          return isBitbucketConfigured();
        case 'bitbucketReviews':
          return isBitbucketConfigured();
        case 'localCodebase':
          return isLocalCodebaseConfigured();
        default:
          return false;
      }
    });

    let systemInstruction: string;
    let persistedSessionId: string | undefined;
    let persistedSessionKind: 'practice' | 'chat' | undefined;

    if (mode === 'practice') {
      if (!sourceSessionId) throw new Error('Practice mode requires sourceSessionId.');
      const source = getSession(sourceSessionId);
      if (!source) throw new Error('Unknown source session.');
      const brief = getPrepBrief(sourceSessionId);
      if (!brief) throw new Error('No prep brief for this session yet — prepare it first.');

      persistedSessionId = uuid();
      persistedSessionKind = 'practice';
      createPrepSession(persistedSessionId, source.languageCodes, `Practice: ${source.name ?? 'session'}`, { sessionType: 'personal', sessionKind: 'practice' });
      systemInstruction = buildPracticeInstruction(brief, source.meetingType ?? 'generic', source.name);
    } else {
      persistedSessionId = uuid();
      persistedSessionKind = 'chat';
      createPrepSession(persistedSessionId, config.languageCodes, `Chat ${new Date().toLocaleString()}`, { sessionType: 'personal', sessionKind: 'chat' });
      systemInstruction = buildChatInstruction();
    }

    const liveSession = new LiveVoiceSession({ systemInstruction, tools: configuredTools });

    const bumpActivity = () => {
      const state = this.voiceSessions.get(client);
      if (state) state.lastActivityAt = Date.now();
    };

    liveSession.on('audio', (chunk: Buffer) => {
      bumpActivity();
      if (client.readyState === WebSocket.OPEN) client.send(chunk);
    });
    liveSession.on('functionCall', (tool: string) => {
      bumpActivity();
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'voice-function-call', tool }));
    });
    liveSession.on('error', (err: any) => {
      console.error('[voice] session error:', err.message);
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'voice-error', error: err.message }));
    });

    // Live transcript relay for the client's on-screen chat log — separate
    // from the practice-mode buffering/persistence below (which exists to
    // write clean segments to the DB, not to update the UI in real time).
    // Every delta is relayed as-is; the client accumulates them into the
    // current bubble itself and starts a fresh one on 'voice-turn-complete'.
    liveSession.on('inputTranscript', (text: string) => {
      bumpActivity();
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'voice-transcript', role: 'you', text }));
    });
    liveSession.on('outputTranscript', (text: string) => {
      bumpActivity();
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'voice-transcript', role: 'assistant', text }));
    });
    liveSession.on('generationComplete', () => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'voice-turn-complete' }));
    });

    let flushTranscript: (() => void) | undefined;

    if (persistedSessionId) {
      const finalSessionId = persistedSessionId;
      const assistantLabel = persistedSessionKind === 'practice' ? 'Practice Partner' : 'Assistant';
      const sessionStart = Date.now();
      let lastEndMs = 0;
      // Confirmed via real Live API traffic: transcription deltas never carry
      // finished:true (despite the field existing in the type), and
      // generationComplete can fire before every trailing transcript/audio
      // chunk has actually arrived (same "trailing results after the
      // signal" behavior session.ts already handles for the STT pipeline).
      // So: accumulate deltas, and debounce the flush — each new delta or a
      // fresh generationComplete pushes the flush out another 800ms; it only
      // actually persists once nothing new has arrived in that window.
      let inputBuffer = '';
      let outputBuffer = '';
      let flushTimer: NodeJS.Timeout | null = null;

      const persistTurn = (speaker: string, text: string) => {
        if (!text.trim()) return;
        const now = Date.now() - sessionStart;
        insertFinalSegment({ sessionId: finalSessionId, speaker, startMs: lastEndMs, endMs: now, text: text.trim(), isFinal: true });
        lastEndMs = now;
      };
      flushTranscript = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        persistTurn('You', inputBuffer);
        persistTurn(assistantLabel, outputBuffer);
        inputBuffer = '';
        outputBuffer = '';
      };
      const scheduleFlush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => flushTranscript!(), 800);
      };

      liveSession.on('inputTranscript', (text: string) => {
        bumpActivity();
        inputBuffer += text;
        scheduleFlush();
      });
      liveSession.on('outputTranscript', (text: string) => {
        bumpActivity();
        outputBuffer += text;
        scheduleFlush();
      });
      liveSession.on('generationComplete', scheduleFlush);
    }

    // Without this, a hung Gemini Live handshake (e.g. a proxy silently
    // dropping the WebSocket upgrade, or a slow/overloaded Live backend) left
    // the client stuck on "Connecting…" forever — connect() never resolved OR
    // rejected, so neither the voice-ready nor the outer .catch()'s
    // voice-error ever fired. abortSignal is client-side-only per the SDK's
    // docs (it won't cancel the request or its billing on Google's end), but
    // it does stop *our* process from holding this promise open indefinitely
    // if the handshake truly never completes.
    let timedOut = false;
    const abortController = new AbortController();
    const connected = liveSession.connect(abortController.signal).then(() => {
      // connect() can still land after we've already given up and told the
      // client it failed — close it rather than leak a live (billed) session.
      if (timedOut) liveSession.close();
    });
    try {
      await Promise.race([
        connected,
        new Promise((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            abortController.abort();
            reject(new Error('Timed out connecting to the Gemini Live voice service.'));
          }, 20_000)
        ),
      ]);
    } catch (err) {
      connected.catch(() => {}); // the abort rejects `connected` too — already handled above, don't crash on an unhandled rejection
      throw err;
    }
    this.voiceSessions.set(client, { session: liveSession, persistedSessionId, persistedSessionKind, flushTranscript, lastActivityAt: Date.now() });

    if (client.readyState === WebSocket.OPEN) {
      client.send(
        persistedSessionKind === 'practice'
          ? JSON.stringify({ type: 'voice-practice-ready', sessionId: persistedSessionId })
          : JSON.stringify({ type: 'voice-ready', sessionId: persistedSessionId })
      );
    }
  }

  private stopVoiceSession(client: WebSocket): void {
    const state = this.voiceSessions.get(client);
    if (!state) return;
    this.voiceSessions.delete(client);
    state.session.close();

    if (state.persistedSessionId) {
      const sessionId = state.persistedSessionId;
      state.flushTranscript?.(); // don't lose whatever's still buffered when the user stops mid-debounce
      endSession(sessionId);

      // Coaching analysis only makes sense for practice (a roleplay run being
      // scored) — a chat session is just a Q&A log, nothing to critique.
      if (state.persistedSessionKind === 'practice') {
        analyzeConversation(sessionId)
          .then((analyzed) => {
            if (!analyzed) return; // no "You" speech captured this run — nothing to score, not worth erroring on
            const feedback = saveCoachingFeedback(sessionId, analyzed);
            this.broadcastCoaching(sessionId, feedback);
          })
          .catch((err: any) => {
            console.error('[voice] practice coaching failed:', err.message);
            this.broadcastCoachingFailed(sessionId, err.message);
          });
      }
    }
  }

  /** Wires session start/stop to actual capture+transcription logic, owned by the caller (index.ts). */
  setHandlers(handlers: { onStart: StartHandler; onStop: StopHandler }): void {
    this.onStartHandler = handlers.onStart;
    this.onStopHandler = handlers.onStop;
  }

  start(): void {
    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${config.httpPort} is already in use — set a different HTTP_PORT in .env.`);
      } else {
        console.error('Interface server error:', err.message);
      }
      process.exit(1);
    });

    this.httpServer.listen(config.httpPort, () => {
      console.log(`Live transcript view: http://localhost:${config.httpPort}`);
    });

    this.scheduleTimer = setInterval(() => this.checkScheduledSessions(), 20_000);
    this.voiceIdleCheckTimer = setInterval(() => this.checkIdleVoiceSessions(), 30_000);
    this.msGraphSyncTimer = setInterval(() => this.runMsGraphSync(), config.msGraphPollMinutes * 60_000);
  }

  stop(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.voiceIdleCheckTimer) clearInterval(this.voiceIdleCheckTimer);
    if (this.msGraphSyncTimer) clearInterval(this.msGraphSyncTimer);
    for (const [client] of this.voiceSessions) this.stopVoiceSession(client);
    this.wss.close();
    this.httpServer.close();
  }

  /**
   * Fire-and-forget — called both by the poll timer and the manual "Sync
   * now" route. Skipped silently (not an error) when unconfigured, same as
   * the calendar poller's rationale elsewhere: most installs won't have this
   * set up, and a 15-minute timer logging "not configured" every tick would
   * be noise.
   */
  private runMsGraphSync(): void {
    if (this.msGraphSyncInProgress || !isMsGraphConfigured()) return;
    this.msGraphSyncInProgress = true;
    syncOutlookAndTeams()
      .then((result) => {
        this.msGraphLastSyncAt = new Date().toISOString();
        this.msGraphLastError = null;
        console.log(`[msgraph] synced ${result.emailCount} email(s), ${result.chatMessageCount} chat message(s)`);
      })
      .catch((err: any) => {
        this.msGraphLastError = err.message;
        console.error('[msgraph] sync failed:', err.message);
      })
      .finally(() => {
        this.msGraphSyncInProgress = false;
      });
  }

  /** Safety net, not a UX feature — see config.voiceSessionIdleTimeoutMs. */
  private checkIdleVoiceSessions(): void {
    const now = Date.now();
    for (const [client, state] of this.voiceSessions) {
      if (now - state.lastActivityAt < config.voiceSessionIdleTimeoutMs) continue;
      console.log('[voice] closing idle session after', config.voiceSessionIdleTimeoutMs, 'ms of inactivity');
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'voice-idle-timeout' }));
      this.stopVoiceSession(client);
    }
  }

  /**
   * Auto-starts the earliest due scheduled session, reusing the exact same
   * onStartHandler the manual "Start recording" button/POST /api/session/start
   * already call — no separate start logic to keep in sync. If another
   * session is already recording, this just skips the tick and retries every
   * 20s until it's free; a schedule that arrives while the app was
   * closed/asleep starts immediately once noticed rather than being treated
   * as "missed."
   */
  private checkScheduledSessions(): void {
    if (this.currentSessionId || !this.onStartHandler) return;
    const due = getDueScheduledSessions(new Date().toISOString());
    if (due.length === 0) return;
    const next = due[0];
    this.onStartHandler(next.languageCodes[0], next.name ?? undefined, next.id);
  }

  setSession(sessionId: string, name?: string): void {
    this.currentSessionId = sessionId;
    this.broadcast({ type: 'session-start', sessionId, name: name || null });
  }

  broadcastSegment(segment: TranscriptSegment): void {
    this.broadcast({ type: 'segment', segment });
  }

  /** envelope is a flat [min0, max0, min1, max1, ...] array, each pair a normalized (-1..1) sample range over a short time window — see src/audio-capture/waveform.ts. */
  broadcastWaveform(sessionId: string, envelope: number[]): void {
    this.broadcast({ type: 'waveform', sessionId, envelope });
  }

  broadcastDiarizing(sessionId: string): void {
    this.broadcast({ type: 'diarizing', sessionId });
  }

  broadcastDiarized(sessionId: string, segments: TranscriptSegment[]): void {
    this.broadcast({ type: 'diarized', sessionId, segments });
  }

  broadcastDiarizationFailed(sessionId: string, error: string): void {
    this.broadcast({ type: 'diarization-failed', sessionId, error });
  }

  broadcastSummarizing(sessionId: string): void {
    this.broadcast({ type: 'summarizing', sessionId });
  }

  broadcastSummarized(sessionId: string, summary: Summary, actionItems: ActionItem[]): void {
    this.broadcast({ type: 'summarized', sessionId, summary, actionItems });
  }

  broadcastSummarizationFailed(sessionId: string, error: string): void {
    this.broadcast({ type: 'summarization-failed', sessionId, error });
  }

  broadcastCoaching(sessionId: string, feedback: CoachingFeedback): void {
    this.broadcast({ type: 'coaching', sessionId, feedback });
  }

  broadcastCoachingFailed(sessionId: string, error: string): void {
    this.broadcast({ type: 'coaching-failed', sessionId, error });
  }

  broadcastChaptersDetecting(sessionId: string): void {
    this.broadcast({ type: 'chapters-detecting', sessionId });
  }

  broadcastChaptersDetected(sessionId: string, chapters: MeetingChapters): void {
    this.broadcast({ type: 'chapters-detected', sessionId, chapters });
  }

  broadcastChaptersDetectionFailed(sessionId: string, error: string): void {
    this.broadcast({ type: 'chapters-detection-failed', sessionId, error });
  }

  broadcastSentiment(sessionId: string, speaker: string, startMs: number, endMs: number, score: number, magnitude: number): void {
    this.broadcast({ type: 'sentiment', sessionId, speaker, startMs, endMs, score, magnitude });
  }

  broadcastTrigger(event: TriggerEvent): void {
    this.broadcast({ type: 'trigger', ...event });
  }

  broadcastSuggestion(suggestion: Suggestion): void {
    this.broadcast({ type: 'suggestion', suggestion });
  }

  broadcastFactCheck(factCheck: FactCheck): void {
    this.broadcast({ type: 'fact-check', factCheck });
  }

  /**
   * Fired for every factual_claim trigger's fact-check outcome — unlike
   * broadcastFactCheck (only conflicts, shown as cards in the Suggestions
   * panel), this always fires so the Triggers tab can show live check status
   * ("Checking…" → result) for every attempt, not just surfaced conflicts.
   */
  broadcastTriggerFactCheck(
    sessionId: string,
    triggerId: number,
    status: 'pending' | 'checked' | 'skipped' | 'not-configured' | 'error',
    factCheck: FactCheck | null
  ): void {
    this.broadcast({ type: 'trigger-fact-check', sessionId, triggerId, status, factCheck });
  }

  broadcastLiveQuery(query: LiveQuery): void {
    this.broadcast({ type: 'live-query', query });
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }
}

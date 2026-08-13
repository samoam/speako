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
  setScheduledEndAt,
  getDueScheduledSessions,
  isScheduledEndDue,
  endSession,
  insertFinalSegment,
  setPrepStatus,
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
  setActionItemType,
  setActionItemExternalRef,
  getUnnotifiedReminders,
  markReminderNotified,
  saveSummaryAndActionItems,
  insertManualActionItem,
  deleteActionItem,
  Summary,
  ActionItem,
  ActionItemType,
  ACTION_ITEM_TYPES,
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
import { getLogBuffer, onLogEntry, LogEntry } from '../logging/logStore';
import { insertCrossSessionQuery, getCrossSessionQueryHistory } from '../storage/crossSessionQueryRepository';
import { runCodebaseIndex } from '../codebase/indexCodebase';
import { getIndexedRepoSummary } from '../storage/codeRepository';
import { updateSettings } from '../settingsStore';
import { ALL_TOOL_KEYS, ToolKey } from '../tools/activeTools';
import { ALL_FEATURE_KEYS, FEATURE_LABELS } from '../tools/activeFeatures';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { isJiraConfigured, createJiraIssue, updateJiraIssue } from '../integrations/jiraMcp';
import { isConfluenceConfigured, createConfluencePage, updateConfluencePage } from '../integrations/confluenceMcp';
import {
  suggestJiraFields,
  suggestConfluenceFields,
  suggestEmailFields,
  suggestTeamsMessageFields,
  suggestScheduleMeetingFields,
} from '../summarization/actionItemDrafts';
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
import { getCurrentWeekEvents, importUpcomingEventsThisWeek } from '../calendar/calendarImport';
import { getSessionIdByCalendarEventId } from '../storage/segmentRepository';
import {
  isClaudeCodeConfigured,
  resolveLocalRepoPath,
  startClaudeCodeTask,
  getTaskInfo,
  getWorktreeDiff,
  applyCodeChangeToRepo,
  pushRepoChanges,
  discardCodeChangeTask,
} from '../integrations/claudeCodeCli';
import {
  createCodeChangeRequest,
  getCodeChangeRequest,
  getLatestCodeChangeRequestForActionItem,
  markCodeChangeReady,
  markCodeChangeFailed,
  markCodeChangeApplied,
  markCodeChangePushed,
  markCodeChangeDiscarded,
} from '../storage/codeChangeRequestRepository';

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
  'calendarImportEnabled',
  'calendarImportPollMinutes',
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
type PauseHandler = () => void;
type ResumeHandler = () => void;

export class InterfaceServer {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private currentSessionId: string | null = null;
  /** True while the currently-recording session is paused — distinct from currentSessionId being null (stopped entirely). Reset whenever a session starts or stops. */
  private paused = false;
  private onStartHandler: StartHandler | null = null;
  private onStopHandler: StopHandler | null = null;
  private onPauseHandler: PauseHandler | null = null;
  private onResumeHandler: ResumeHandler | null = null;
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
  private calendarImportInProgress = false;
  private calendarImportLastRunAt: string | null = null;
  private calendarImportLastError: string | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private voiceIdleCheckTimer: NodeJS.Timeout | null = null;
  private msGraphSyncTimer: NodeJS.Timeout | null = null;
  private calendarImportTimer: NodeJS.Timeout | null = null;

  constructor() {
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/status', (_req, res) => {
      res.json({ recording: !!this.currentSessionId, sessionId: this.currentSessionId, paused: this.paused });
    });

    app.get('/api/languages', (_req, res) => {
      res.json(SUPPORTED_LANGUAGES);
    });

    app.get('/api/logs', (_req, res) => {
      res.json({ logs: getLogBuffer() });
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
      // Raw Outlook/Google metadata for the picked calendar event, if any —
      // sent by the New Session modal's calendar-shortcut picker, which
      // already has the full CalendarEvent object client-side (see
      // loadCalendarShortcuts() in index.html). Only meaningful alongside
      // calendarEventId; a manually-typed session with no calendar event
      // simply won't send any of these.
      const calendarLocation = typeof req.body?.calendarLocation === 'string' ? req.body.calendarLocation : undefined;
      const calendarOrganizer = typeof req.body?.calendarOrganizer === 'string' ? req.body.calendarOrganizer : undefined;
      const calendarAttendees = Array.isArray(req.body?.calendarAttendees)
        ? req.body.calendarAttendees.filter((a: unknown): a is string => typeof a === 'string')
        : undefined;
      const calendarDescription = typeof req.body?.calendarDescription === 'string' ? req.body.calendarDescription.slice(0, 2000) : undefined;
      const calendarMeetingInfo = calendarEventId
        ? { location: calendarLocation, organizer: calendarOrganizer, attendees: calendarAttendees, description: calendarDescription }
        : undefined;

      // "Just save the session" — skips running prep now (see prepStatus:
      // 'none', distinct from 'pending') so a manually-created session isn't
      // forced through prep up front; POST /api/sessions/:id/prep below
      // triggers it later, on demand, using what's already stored here.
      const skipPrep = req.body?.skipPrep === true;

      const sessionId = uuid();
      createPrepSession(sessionId, languageCodes, name, {
        prepStatus: skipPrep ? 'none' : 'pending',
        meetingType,
        calendarEventId,
        activeTools,
        activeFeatures,
        scheduledStartAt,
        calendarMeetingInfo,
      });

      if (!skipPrep) {
        runPrep({
          sessionId,
          sessionName: name,
          meetingType,
          calendarEventId,
          userNotes,
          activeTools: activeTools ?? null,
          onDone: (id, status) => this.broadcast({ type: 'prep-ready', sessionId: id, status }),
        }).catch((err: any) => console.error(`[prep] unexpected failure for session ${sessionId}:`, err.message));
      }

      res.json({ sessionId });
    });

    // Manual "run prep now" for a session that skipped it at creation
    // (prepStatus: 'none') or whose prep previously failed — reuses the
    // meetingType/calendarEventId/activeTools already stored on the row;
    // there's no fresh userNotes input at this point (that only exists in
    // the New Session modal), so this reruns without any.
    app.post('/api/sessions/:id/prep', (req, res) => {
      const sessionId = req.params.id;
      const session = getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      if (session.prepStatus === 'pending') {
        res.status(409).json({ error: 'Prep is already running for this session.' });
        return;
      }
      setPrepStatus(sessionId, 'pending');
      this.broadcast({ type: 'prep-started', sessionId });
      res.json({ started: true });

      runPrep({
        sessionId,
        sessionName: session.name || undefined,
        meetingType: (session.meetingType || 'generic') as MeetingType,
        calendarEventId: session.calendarEventId || undefined,
        activeTools: session.activeTools,
        onDone: (id, status) => this.broadcast({ type: 'prep-ready', sessionId: id, status }),
      }).catch((err: any) => console.error(`[prep] unexpected failure for session ${sessionId}:`, err.message));
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
    // This manual endpoint has no way to specify an auto-stop time, so it always
    // clears scheduledEndAt too — otherwise a calendar-imported session's original
    // meeting-end time could linger and immediately auto-stop a later manual
    // recording that has nothing to do with that original schedule.
    app.patch('/api/sessions/:id/schedule', (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      const scheduledStartAt = typeof req.body?.scheduledStartAt === 'string' ? req.body.scheduledStartAt : null;
      setScheduledStartAt(sessionId, scheduledStartAt);
      setScheduledEndAt(sessionId, null);
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

    // Every meeting in the current calendar week (Mon-Sun, local time), each
    // annotated with whether it already has a Speako session — the week-grid
    // calendar view's data source. Never errors on missing config, same
    // rationale as /api/calendar/upcoming.
    app.get('/api/calendar/week', async (_req, res) => {
      try {
        const events = await getCurrentWeekEvents();
        const withSessions = events.map((event) => ({
          ...event,
          sessionId: getSessionIdByCalendarEventId(event.id) ?? null,
        }));
        res.json(withSessions);
      } catch (err: any) {
        console.error('[calendar] failed to list this week\'s events:', err.message);
        res.json([]);
      }
    });

    // Manual out-of-cadence trigger for the same import a background timer
    // (see start()) runs every config.calendarImportPollMinutes — lets the
    // calendar view's "Sync now" button get fresh sessions immediately
    // rather than waiting for the next tick.
    app.post('/api/calendar/import', (_req, res) => {
      if (!isOutlookDesktopConfigured()) {
        res.status(400).json({ error: 'Outlook desktop calendar import is only available on Windows.' });
        return;
      }
      if (this.calendarImportInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runCalendarImport();
      res.json({ started: true });
    });

    app.get('/api/calendar/import/status', (_req, res) => {
      res.json({
        configured: isOutlookDesktopConfigured() && config.calendarImportEnabled,
        inProgress: this.calendarImportInProgress,
        lastRunAt: this.calendarImportLastRunAt,
        lastError: this.calendarImportLastError,
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
      this.paused = false;
      this.broadcast({ type: 'session-stop', sessionId: stoppedId });
      res.json({ stopped: true, sessionId: stoppedId });
    });

    // Temporarily halts capture/transcription without ending the session —
    // distinct from /api/session/stop, which is terminal (sets ended_at).
    // Only meaningful for whichever session is actually recording right now.
    app.post('/api/session/pause', (_req, res) => {
      if (!this.currentSessionId || this.paused) {
        res.json({ paused: false });
        return;
      }
      this.onPauseHandler?.();
      this.paused = true;
      this.broadcast({ type: 'session-pause', sessionId: this.currentSessionId });
      res.json({ paused: true, sessionId: this.currentSessionId });
    });

    app.post('/api/session/resume', (_req, res) => {
      if (!this.currentSessionId || !this.paused) {
        res.json({ resumed: false });
        return;
      }
      this.onResumeHandler?.();
      this.paused = false;
      this.broadcast({ type: 'session-resume', sessionId: this.currentSessionId });
      res.json({ resumed: true, sessionId: this.currentSessionId });
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

    // User-entered action items — independent of AI summarization, so they
    // work whether or not a summary has ever been generated for this
    // session, and survive future re-summarization (see
    // saveSummaryAndActionItems' confidence filter).
    app.post('/api/sessions/:id/action-items', (req, res) => {
      const sessionId = req.params.id;
      if (!getSession(sessionId)) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      if (!description) {
        res.status(400).json({ error: 'Description is required.' });
        return;
      }
      const owner = typeof req.body?.owner === 'string' ? req.body.owner.trim() : null;
      const dueDate = typeof req.body?.dueDate === 'string' ? req.body.dueDate.trim() : null;
      const type = ACTION_ITEM_TYPES.includes(req.body?.type) ? (req.body.type as ActionItemType) : 'general';
      const item = insertManualActionItem(sessionId, { owner, description, dueDate, type });
      this.broadcast({ type: 'action-item-added', sessionId, actionItem: item });
      res.json(item);
    });

    app.delete('/api/action-items/:id', (req, res) => {
      const id = Number(req.params.id);
      const item = getActionItem(id);
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      deleteActionItem(id);
      this.broadcast({ type: 'action-item-deleted', sessionId: item.sessionId, actionItemId: id });
      res.json({ ok: true });
    });

    // AI-drafted starting point for the Jira/Confluence dialogs — read-only,
    // never itself creates/updates anything. Fired once when a dialog opens;
    // the user still reviews and can edit every field before submitting.
    app.get('/api/action-items/:id/jira/suggest', async (req, res) => {
      const item = getActionItem(Number(req.params.id));
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        res.json(await suggestJiraFields(item));
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    app.get('/api/action-items/:id/confluence/suggest', async (req, res) => {
      const item = getActionItem(Number(req.params.id));
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        res.json(await suggestConfluenceFields(item));
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    // Same "draft, then the user still reviews/sends it themselves" pattern
    // as the Jira/Confluence suggest routes above, for the deep-link-only
    // action types — read-only, never sends/posts/creates anything itself.
    app.get('/api/action-items/:id/email/suggest', async (req, res) => {
      const item = getActionItem(Number(req.params.id));
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        res.json(await suggestEmailFields(item));
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    app.get('/api/action-items/:id/teams-message/suggest', async (req, res) => {
      const item = getActionItem(Number(req.params.id));
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        res.json(await suggestTeamsMessageFields(item));
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    app.get('/api/action-items/:id/schedule-meeting/suggest', async (req, res) => {
      const item = getActionItem(Number(req.params.id));
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        res.json(await suggestScheduleMeetingFields(item));
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    // Real write — actually creates or updates a Jira issue (see
    // src/integrations/jiraMcp.ts's createJiraIssue/updateJiraIssue).
    // Explicit, user-confirmed, one item at a time — reached only from the
    // Action Items tab's "Create/update Jira" dialog, never automatically.
    app.post('/api/action-items/:id/jira', async (req, res) => {
      const id = Number(req.params.id);
      const item = getActionItem(id);
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        let result;
        let action: 'created' | 'updated';
        if (req.body?.mode === 'update') {
          const issueKey = typeof req.body?.issueKey === 'string' ? req.body.issueKey.trim() : '';
          const transition = typeof req.body?.transition === 'string' ? req.body.transition.trim() : '';
          const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
          if (!issueKey) {
            res.status(400).json({ error: 'Issue key is required.' });
            return;
          }
          if (!transition && !comment) {
            res.status(400).json({ error: 'Provide a status transition and/or a comment.' });
            return;
          }
          result = await updateJiraIssue({ issueKey, transition: transition || undefined, comment: comment || undefined });
          action = 'updated';
        } else {
          const projectKey = typeof req.body?.projectKey === 'string' ? req.body.projectKey.trim() : '';
          const issueType = typeof req.body?.issueType === 'string' ? req.body.issueType.trim() : '';
          const summary = typeof req.body?.summary === 'string' ? req.body.summary.trim() : item.description;
          const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
          if (!projectKey || !issueType) {
            res.status(400).json({ error: 'Project key and issue type are required.' });
            return;
          }
          result = await createJiraIssue({ projectKey, issueType, summary, description: description || undefined });
          action = 'created';
        }
        setActionItemExternalRef(id, { tool: 'jira', action, key: result.key, url: result.url, at: new Date().toISOString() });
        const updated = getActionItem(id)!;
        this.broadcast({ type: 'action-item-updated', sessionId: item.sessionId, actionItem: updated });
        res.json(updated);
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    // Real write — actually creates or updates a Confluence page (see
    // src/integrations/confluenceMcp.ts). Same explicit, one-item-at-a-time
    // pattern as the Jira route above.
    app.post('/api/action-items/:id/confluence', async (req, res) => {
      const id = Number(req.params.id);
      const item = getActionItem(id);
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      try {
        let result;
        let action: 'created' | 'updated';
        const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : item.description.slice(0, 200);
        const content = typeof req.body?.content === 'string' && req.body.content.trim() ? req.body.content.trim() : item.description;
        if (req.body?.mode === 'update') {
          const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId.trim() : '';
          if (!pageId) {
            res.status(400).json({ error: 'Page ID is required.' });
            return;
          }
          result = await updateConfluencePage({ pageId, title, content });
          action = 'updated';
        } else {
          const spaceKey = typeof req.body?.spaceKey === 'string' ? req.body.spaceKey.trim() : '';
          const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId.trim() : '';
          if (!spaceKey) {
            res.status(400).json({ error: 'Space key is required.' });
            return;
          }
          result = await createConfluencePage({ spaceKey, title, content, parentId: parentId || undefined });
          action = 'created';
        }
        setActionItemExternalRef(id, { tool: 'confluence', action, key: result.id, url: result.url, at: new Date().toISOString() });
        const updated = getActionItem(id)!;
        this.broadcast({ type: 'action-item-updated', sessionId: item.sessionId, actionItem: updated });
        res.json(updated);
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
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
      if (req.body?.status !== undefined) {
        setActionItemStatus(id, req.body.status === 'done' ? 'done' : 'open');
      }
      if (ACTION_ITEM_TYPES.includes(req.body?.type)) {
        setActionItemType(id, req.body.type as ActionItemType);
      }
      const updated = getActionItem(id)!;
      this.broadcast({ type: 'action-item-updated', sessionId: item.sessionId, actionItem: updated });
      res.json(updated);
    });

    // "Implement with Claude Code" — some action items are code changes, not
    // just meeting follow-ups. Launches a background Claude Code CLI agent
    // in an isolated git worktree (never the repo's real working directory)
    // to make the edit; git commit/push are hard-blocked inside that agent
    // (see claudeCodeCli.ts's DISALLOWED_TOOLS) — approving/pushing are
    // separate, later, explicit steps below, never automatic.
    app.post('/api/action-items/:id/implement', async (req, res) => {
      const actionItemId = Number(req.params.id);
      const item = getActionItem(actionItemId);
      if (!item) {
        res.status(404).json({ error: 'Unknown action item.' });
        return;
      }
      const existing = getLatestCodeChangeRequestForActionItem(actionItemId);
      if (existing && existing.status === 'running') {
        res.json({ started: false, alreadyRunning: true, requestId: existing.id });
        return;
      }
      if (!isClaudeCodeConfigured()) {
        res.status(400).json({ error: 'No local codebase configured — see Settings > Local codebase indexing.' });
        return;
      }
      const configuredRepos = config.codebaseLocalPaths;
      const repoName =
        typeof req.body?.repoName === 'string' && req.body.repoName
          ? req.body.repoName
          : configuredRepos.length === 1
            ? configuredRepos[0].name
            : null;
      if (!repoName) {
        res.status(400).json({ error: 'Multiple local codebases configured — specify which one via repoName.', options: configuredRepos.map((r) => r.name) });
        return;
      }
      let repoPath: string;
      try {
        repoPath = resolveLocalRepoPath(repoName);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }

      try {
        const prompt = `Implement this action item from a meeting. Description: ${item.description}${item.owner ? ` (owner: ${item.owner})` : ''}`;
        const { cliSessionId } = await startClaudeCodeTask(prompt, repoPath);
        const request = createCodeChangeRequest({ actionItemId, sessionId: item.sessionId, repoName, repoPath, cliSessionId });
        this.pollCodeChangeRequest(request.id).catch((err: any) => console.error('[claude-code] polling failed:', err.message));
        this.broadcast({ type: 'code-change-started', actionItemId, requestId: request.id });
        res.json({ started: true, requestId: request.id });
      } catch (err: any) {
        console.error('[claude-code] failed to start task:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/action-items/:id/code-change', (req, res) => {
      const actionItemId = Number(req.params.id);
      const request = getLatestCodeChangeRequestForActionItem(actionItemId);
      res.json(request ?? null);
    });

    app.post('/api/code-change-requests/:id/approve', async (req, res) => {
      const id = Number(req.params.id);
      const request = getCodeChangeRequest(id);
      if (!request) {
        res.status(404).json({ error: 'Unknown code change request.' });
        return;
      }
      if (request.status !== 'ready') {
        res.status(400).json({ error: `Cannot approve a request in status "${request.status}" — must be "ready".` });
        return;
      }
      try {
        const actionItem = getActionItem(request.actionItemId);
        const commitMessage = `Implement: ${(actionItem?.description ?? 'action item').slice(0, 200)}`;
        await applyCodeChangeToRepo(request.diff ?? '', request.repoPath, commitMessage);
        markCodeChangeApplied(id);
        this.broadcast({ type: 'code-change-applied', actionItemId: request.actionItemId, requestId: id });
        res.json(getCodeChangeRequest(id));
      } catch (err: any) {
        console.error('[claude-code] approve failed:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // Deliberately separate from /approve — commit and push are two
    // distinct gates a human has to click through, not one bundled action.
    app.post('/api/code-change-requests/:id/push', async (req, res) => {
      const id = Number(req.params.id);
      const request = getCodeChangeRequest(id);
      if (!request) {
        res.status(404).json({ error: 'Unknown code change request.' });
        return;
      }
      if (request.status !== 'applied') {
        res.status(400).json({ error: `Cannot push a request in status "${request.status}" — must be "applied" first.` });
        return;
      }
      try {
        await pushRepoChanges(request.repoPath);
        markCodeChangePushed(id);
        this.broadcast({ type: 'code-change-pushed', actionItemId: request.actionItemId, requestId: id });
        res.json(getCodeChangeRequest(id));
      } catch (err: any) {
        console.error('[claude-code] push failed:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.post('/api/code-change-requests/:id/discard', async (req, res) => {
      const id = Number(req.params.id);
      const request = getCodeChangeRequest(id);
      if (!request) {
        res.status(404).json({ error: 'Unknown code change request.' });
        return;
      }
      if (request.status === 'applied' || request.status === 'pushed' || request.status === 'discarded') {
        res.status(400).json({ error: `Cannot discard a request in status "${request.status}".` });
        return;
      }
      try {
        let worktreePath = request.worktreePath;
        if (!worktreePath) {
          const info = await getTaskInfo(request.cliSessionId);
          worktreePath = info?.cwd ?? null;
        }
        if (worktreePath) await discardCodeChangeTask(request.cliSessionId, worktreePath, request.repoPath);
        markCodeChangeDiscarded(id);
        this.broadcast({ type: 'code-change-discarded', actionItemId: request.actionItemId, requestId: id });
        res.json(getCodeChangeRequest(id));
      } catch (err: any) {
        console.error('[claude-code] discard failed:', err.message);
        res.status(500).json({ error: err.message });
      }
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
      client.send(JSON.stringify({ type: 'status', recording: !!this.currentSessionId, sessionId: this.currentSessionId, paused: this.paused }));
      // Catches a reminder that came due while every tab was closed — see checkReminders()'s doc comment.
      this.checkReminders();

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
          // name/languageCode/activeTools only ever come from the "Chat with
          // AI" button in the New Session modal (index.html's chatWithAiBtn
          // handler) — the sidebar header's mic icon still starts a chat with
          // none of these set, falling back to the global defaults exactly
          // as before this existed.
          const chatOptions = {
            name: typeof msg.name === 'string' ? msg.name.trim().slice(0, 200) || undefined : undefined,
            languageCode: typeof msg.languageCode === 'string' ? msg.languageCode : undefined,
            activeTools: Array.isArray(msg.activeTools)
              ? msg.activeTools.filter((t: unknown): t is string => typeof t === 'string' && ALL_TOOL_KEYS.includes(t as any))
              : undefined,
          };
          this.startVoiceSession(client, msg.mode, msg.sourceSessionId, chatOptions).catch((err: any) => {
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

    // Streams every console.log/info/warn/error to every connected client —
    // subscribed once here (not per-connection) since it's a single global
    // firehose, same lifetime as the server itself.
    onLogEntry((entry) => this.broadcastLogLine(entry));
  }

  /** mode 'practice': creates a new session (grounded by sourceSessionId's prep brief) so the roleplay gets full history + real coaching feedback afterward, same as any real meeting. mode 'chat': also creates a real session now (session_kind='chat'), so it shows up in the sidebar's Chat history tab — no coaching analysis, since it's not a roleplay run. */
  private async startVoiceSession(
    client: WebSocket,
    mode: 'chat' | 'practice',
    sourceSessionId?: string,
    chatOptions?: { name?: string; languageCode?: string; activeTools?: string[] }
  ): Promise<void> {
    if (this.voiceSessions.has(client)) return;
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

    // A chat session created via the New Session modal's "Chat with AI"
    // button carries its own explicit tool selection (chatOptions.activeTools,
    // possibly an empty array — "no tools", a real choice) — otherwise (the
    // sidebar mic icon, or practice mode) fall back to the global
    // Settings > Voice chat tools default, same as always. Either way,
    // still filtered down to whichever are actually configured — picking a
    // tool here does nothing on its own if it has no real credentials/path.
    const requestedTools: string[] = (mode === 'chat' ? chatOptions?.activeTools : undefined) ?? config.voiceToolKeys;
    const configuredTools = requestedTools.filter((tool): tool is ToolKey => {
      if (!VOICE_TOOL_KEYS.includes(tool as ToolKey)) return false; // ignore anything outside the eligible ceiling (stale setting, manual edit, non-voice-eligible tool picked in the modal)
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
      createPrepSession(persistedSessionId, source.languageCodes, `Practice: ${source.name ?? 'session'}`, { sessionKind: 'practice' });
      systemInstruction = buildPracticeInstruction(brief, source.meetingType ?? 'generic', source.name);
    } else {
      persistedSessionId = uuid();
      persistedSessionKind = 'chat';
      const languageCodes = chatOptions?.languageCode ? [chatOptions.languageCode] : config.languageCodes;
      createPrepSession(persistedSessionId, languageCodes, chatOptions?.name || `Chat ${new Date().toLocaleString()}`, {
        sessionKind: 'chat',
        // The raw, unfiltered selection from the modal (undefined when
        // started via the sidebar mic icon instead) — null on the row means
        // "all globally-configured tools," same convention as meeting
        // sessions. configuredTools above is the filtered-for-Gemini subset,
        // never what gets persisted.
        activeTools: chatOptions?.activeTools,
      });
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
  setHandlers(handlers: { onStart: StartHandler; onStop: StopHandler; onPause: PauseHandler; onResume: ResumeHandler }): void {
    this.onStartHandler = handlers.onStart;
    this.onStopHandler = handlers.onStop;
    this.onPauseHandler = handlers.onPause;
    this.onResumeHandler = handlers.onResume;
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

    this.scheduleTimer = setInterval(() => {
      this.checkScheduledSessions();
      this.checkScheduledEndSessions();
      this.checkReminders();
    }, 20_000);
    this.voiceIdleCheckTimer = setInterval(() => this.checkIdleVoiceSessions(), 30_000);
    this.msGraphSyncTimer = setInterval(() => this.runMsGraphSync(), config.msGraphPollMinutes * 60_000);
    this.calendarImportTimer = setInterval(() => this.runCalendarImport(), config.calendarImportPollMinutes * 60_000);
  }

  stop(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.voiceIdleCheckTimer) clearInterval(this.voiceIdleCheckTimer);
    if (this.msGraphSyncTimer) clearInterval(this.msGraphSyncTimer);
    if (this.calendarImportTimer) clearInterval(this.calendarImportTimer);
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

  /**
   * Fire-and-forget, called both by the poll timer and the manual "Sync
   * calendar" route. Runs on a timer despite the same Outlook Object Model
   * Guard risk documented on /api/outlook-desktop/sync above — a deliberate,
   * explicitly-requested exception to that precedent for this feature (see
   * NOTES.md); the underlying export script's 60s timeout at least keeps a
   * stuck run from hanging the poll loop forever. Broadcasts one
   * 'calendar-session-created' event per newly-imported session so the
   * sidebar and calendar view can refresh without a manual reload.
   */
  private runCalendarImport(): void {
    if (this.calendarImportInProgress || !isOutlookDesktopConfigured() || !config.calendarImportEnabled) return;
    this.calendarImportInProgress = true;
    importUpcomingEventsThisWeek((sessionId, event) => {
      this.broadcast({ type: 'calendar-session-created', sessionId, eventId: event.id, name: event.title });
    })
      .then((result) => {
        this.calendarImportLastRunAt = new Date().toISOString();
        this.calendarImportLastError = null;
        console.log(`[calendar-import] created ${result.createdSessionIds.length} session(s), ${result.skipped} already imported`);
      })
      .catch((err: any) => {
        this.calendarImportLastError = err.message;
        console.error('[calendar-import] failed:', err.message);
      })
      .finally(() => {
        this.calendarImportInProgress = false;
      });
  }

  /**
   * Polls `claude agents --json` (see claudeCodeCli.ts's getTaskInfo) every
   * 10s until the background agent reaches a terminal state, capped at 20
   * minutes so a runaway/stuck task can't poll forever.
   *
   * 'blocked' is NOT a reliable failure signal on its own — confirmed via a
   * real smoke test: an agent that finishes editing and then tries the
   * (intentionally denied) `git commit` also ends up in state 'blocked',
   * even though the edit itself succeeded and is exactly the diff we want
   * to offer for approval. So 'done' and 'blocked' are both treated as
   * "may have produced a usable diff" — the actual failure test is whether
   * getWorktreeDiff() comes back empty, not the state string itself.
   * 'stopped'/'failed'/'error' still fail immediately since there is
   * nothing to double-check a diff against there.
   */
  private async pollCodeChangeRequest(requestId: number): Promise<void> {
    const POLL_INTERVAL_MS = 10_000;
    const MAX_ATTEMPTS = 120; // 20 minutes
    const MAYBE_DONE_STATES = ['done', 'blocked'];
    const FAILURE_STATES = ['stopped', 'failed', 'error'];

    const request = getCodeChangeRequest(requestId);
    if (!request) return;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      let info;
      try {
        info = await getTaskInfo(request.cliSessionId);
      } catch (err: any) {
        console.error(`[claude-code] status check failed for request ${requestId}:`, err.message);
        continue; // transient CLI hiccup — keep trying rather than failing the whole task on one bad poll
      }
      if (!info) continue; // not registered yet, or briefly missing — keep polling

      if (MAYBE_DONE_STATES.includes(info.state)) {
        try {
          const diff = await getWorktreeDiff(info.cwd);
          if (!diff.trim()) {
            const error = `Claude Code agent ended in state "${info.state}" with no file changes — check \`claude logs ${request.cliSessionId}\` for details.`;
            markCodeChangeFailed(requestId, error);
            this.broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, requestId, error });
            return;
          }
          markCodeChangeReady(requestId, info.cwd, diff);
          this.broadcast({ type: 'code-change-ready', actionItemId: request.actionItemId, requestId });
        } catch (err: any) {
          markCodeChangeFailed(requestId, err.message);
          this.broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, requestId, error: err.message });
        }
        return;
      }
      if (FAILURE_STATES.includes(info.state)) {
        const error = `Claude Code agent ended in state "${info.state}" — check \`claude logs ${request.cliSessionId}\` for details.`;
        markCodeChangeFailed(requestId, error);
        this.broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, requestId, error });
        return;
      }
      // else: still running (or an unrecognized-but-non-terminal status) — keep polling
    }

    const timeoutError = 'Timed out waiting for the Claude Code agent after 20 minutes.';
    markCodeChangeFailed(requestId, timeoutError);
    this.broadcast({ type: 'code-change-failed', actionItemId: request.actionItemId, requestId, error: timeoutError });
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

  /**
   * Mirrors checkScheduledSessions() but for the other end of a scheduled
   * meeting — auto-stops the currently-recording session once its
   * `scheduledEndAt` (set from a calendar event's end time by
   * src/calendar/calendarImport.ts) arrives, reusing the exact same
   * onStopHandler + broadcast sequence POST /api/session/stop uses. Only
   * ever checks the one session actually recording (Speako's single-
   * concurrent-recording model) — a session that never started recording,
   * or already ended some other way, has nothing to auto-stop.
   */
  private checkScheduledEndSessions(): void {
    if (!this.currentSessionId || !this.onStopHandler) return;
    if (!isScheduledEndDue(this.currentSessionId, new Date().toISOString())) return;
    const stoppedId = this.currentSessionId;
    this.onStopHandler();
    this.currentSessionId = null;
    this.broadcast({ type: 'session-stop', sessionId: stoppedId });
  }

  /**
   * Replaces the old client-only setTimeout-based reminder (index.html) —
   * that overflowed silently for anything more than ~24.8 days out
   * (setTimeout's delay is a 32-bit signed int) and lost the pending
   * reminder outright on any page refresh, with no way to re-arm it.
   * Checked on the same 20s timer as the scheduling logic above, plus once
   * whenever a new client connects (see this.wss.on('connection', ...)) so
   * a reminder that came due while every tab was closed still fires the
   * moment the app is next opened, instead of being silently marked
   * notified with nobody around to see it.
   */
  private checkReminders(): void {
    const now = Date.now();
    for (const item of getUnnotifiedReminders()) {
      const target = new Date(`${item.dueDate}T09:00:00`).getTime();
      if (Number.isNaN(target) || target > now) continue;
      markReminderNotified(item.id);
      this.broadcast({ type: 'reminder-due', actionItem: item });
    }
  }

  setSession(sessionId: string, name?: string): void {
    this.currentSessionId = sessionId;
    this.paused = false;
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

  broadcastLogLine(entry: LogEntry): void {
    this.broadcast({ type: 'log-line', entry });
  }

  broadcastTranscriptionError(sessionId: string, message: string): void {
    this.broadcast({ type: 'transcription-error', sessionId, message });
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }
}

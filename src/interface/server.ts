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
  resumeSession,
} from '../storage/segmentRepository';
import { LiveVoiceSession, VOICE_TOOL_KEYS } from '../voice/liveVoiceSession';
import { buildChatInstruction, buildPracticeInstruction, buildResumeInstruction } from '../voice/systemInstructions';
import { diarizeSession, deleteUploadedAudio } from '../diarization/diarize';
import { SUPPORTED_LANGUAGES } from '../languages';
import { toPlainText } from '../transcriptFormat';
import { cleanGeminiErrorMessage } from '../gemini/geminiClient';
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
import { listUpcomingMicrosoft365Events } from '../integrations/microsoft365Calendar';
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
import { generateAudioOverview } from '../summarization/generateAudioOverview';
import { gatherAudioOverviewContext } from '../summarization/audioOverviewContext';
import {
  insertAudioOverview,
  getAudioOverview,
  getAudioOverviewForSession,
  deleteAudioOverview,
  AudioOverview,
} from '../storage/audioOverviewRepository';
import { runCodebaseIndex } from '../codebase/indexCodebase';
import { getIndexedRepoSummary } from '../storage/codeRepository';
import { updateSettings } from '../settingsStore';
import { ALL_TOOL_KEYS, ToolKey } from '../tools/activeTools';
import { ALL_FEATURE_KEYS, FEATURE_LABELS } from '../tools/activeFeatures';
import { isBitbucketConfigured } from '../integrations/bitbucketServer';
import { isJiraConfigured, createJiraIssue, updateJiraIssue, getJiraIssueDetail } from '../integrations/jiraMcp';
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
import { getExternalMessageIndexSummary, hasAnyExternalMessages, getExternalMessageById } from '../storage/externalMessageRepository';
import { syncOutlookMail } from '../integrations/outlookMailSync';
import { syncTeamsMessages } from '../integrations/teamsConnectorSync';
import { runTeamsMessageTriage } from '../communications/teamsMessageTriage';
import { runEmailTriage } from '../communications/emailTriage';
import { isWithinBusinessHours } from '../util/businessHours';
import { getCurrentWeekEvents, importUpcomingEventsThisWeek } from '../calendar/calendarImport';
import { getSessionIdByCalendarEventId } from '../storage/segmentRepository';
import { syncTasks } from '../orchestrator/taskSync';
import { getOpenTasks, getTaskById, dismissTask, updateTaskBoardStatus } from '../storage/taskRepository';
import {
  isClaudeCodeConfigured,
  resolveLocalRepoPath,
  startClaudeCodeTask,
  getTaskInfo,
  getWorktreeDiff,
  applyCodeChangeToRepo,
  pushRepoChanges,
  discardCodeChangeTask,
  createWorktreeForBranch,
  removeWorktree,
  runClaudeCodeReview,
} from '../integrations/claudeCodeCli';
import {
  createCodeChangeRequest,
  getCodeChangeRequest,
  getLatestCodeChangeRequestForActionItem,
  getLatestCodeChangeRequestForTask,
  markCodeChangeReady,
  markCodeChangeFailed,
  markCodeChangeApplied,
  markCodeChangePushed,
  markCodeChangeDiscarded,
} from '../storage/codeChangeRequestRepository';
import { pollCodeChangeRequest } from '../integrations/codeChangePoller';
import { pollJenkinsBuilds } from '../dev/jenkinsMonitor';
import { getPullRequest } from '../integrations/bitbucketServer';
import { gatherReviewContext, buildReviewPrompt, REVIEW_JSON_SCHEMA } from '../summarization/prReviewContext';
import {
  createPrReviewRequest,
  getPrReviewRequest,
  getLatestPrReviewRequestForTask,
  setPrReviewContext,
  appendPrReviewLog,
  markPrReviewReady,
  markPrReviewFailed,
} from '../storage/prReviewRequestRepository';
import '../drafts/kinds'; // side-effect only: registers every known draft kind (teams_reply, email_reply, ...) with src/drafts/registry.ts
import { getDraft, getDraftRevisions, getLatestDraftForSubject, getDraftsForSubject, getDraftsForSubjectPrefix, getActiveDraftsByStatus, DraftSubjectKind } from '../storage/draftRepository';
import { getTodaysBriefing, saveTodaysBriefing } from '../storage/dailyBriefingRepository';
import { buildMorningBriefing } from '../summarization/morningBriefing';
import { prCommentSubjectId } from '../drafts/kinds/bitbucketPrCommentDraft';
import { setDraftBroadcast, reconcileStuckDrafts, startDraft, refineDraft, editDraftContent, approveDraftGate, discardDraft, redoDraft, DraftConflictError } from '../drafts/draftService';
import { createDevCycle, getDevCycle, getActiveDevCycleForTicket, BranchType } from '../storage/devCycleRepository';

const SETTINGS_FIELDS = [
  'geminiApiKey',
  'geminiModel',
  'geminiLiveModel',
  'geminiFastModel',
  'geminiTtsModel',
  'jiraUrl',
  'jiraPersonalToken',
  'confluenceUrl',
  'confluenceUsername',
  'confluenceApiToken',
  'bitbucketServerUrl',
  'bitbucketServerUsername',
  'bitbucketServerToken',
  'bitbucketServerRepos',
  'jenkinsUrl',
  'jenkinsUser',
  'jenkinsApiToken',
  'jenkinsJobFolders',
  'jenkinsPollMinutes',
  'devTrunkBranch',
  'prePrMaxChangedFiles',
  'prePrMaxChangedLines',
  'mem0McpUrl',
  'mem0McpApiKey',
  'ragMcpUrl',
  'ragMcpApiKey',
  'googleCalendarCredentialsPath',
  'googleCalendarTokenPath',
  'prepWindowMinutes',
  'codebaseLocalPaths',
  'voiceToolKeys',
  'emailSyncPollMinutes',
  'emailSyncLookbackHours',
  'teamsSyncPollMinutes',
  'teamsSyncLookbackHours',
  'calendarImportEnabled',
  'calendarImportPollMinutes',
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
  if (key === 'jenkinsJobFolders') {
    return (value as { name: string; folderPath: string }[]).map((p) => `${p.name}=${p.folderPath}`).join(',');
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
      /** Persists one already-complete turn (a debounced-flushed spoken utterance, or an immediately-final typed message) and broadcasts it as a real 'segment' — the same shape/handler a live meeting's transcript uses, so a live chat/practice session's main-panel view updates the same way. */
      persistTurn?: (speaker: string, text: string) => void;
      lastActivityAt: number;
    }
  >();
  private codebaseIndexInProgress = false;
  private communicationsIndexInProgress = false;
  private morningBriefingInProgress = false;
  private emailSyncInProgress = false;
  private emailSyncLastSyncAt: string | null = null;
  private emailSyncLastError: string | null = null;
  private teamsSyncInProgress = false;
  private teamsSyncLastSyncAt: string | null = null;
  private teamsSyncLastError: string | null = null;
  private calendarImportInProgress = false;
  private calendarImportLastRunAt: string | null = null;
  private calendarImportLastError: string | null = null;
  private orchestratorSyncInProgress = false;
  private orchestratorLastRunAt: string | null = null;
  private orchestratorLastError: string | null = null;
  private jenkinsSyncInProgress = false;
  private jenkinsSyncTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private voiceIdleCheckTimer: NodeJS.Timeout | null = null;
  private emailSyncTimer: NodeJS.Timeout | null = null;
  private calendarImportTimer: NodeJS.Timeout | null = null;
  private teamsSyncTimer: NodeJS.Timeout | null = null;
  private orchestratorSyncTimer: NodeJS.Timeout | null = null;

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
    // Google Calendar first if configured; the Microsoft 365 connector as a
    // fallback (its own separate integration, not merged/deduped with
    // Google's events — see NOTES.md) for calendars Google can't see at all.
    app.get('/api/calendar/upcoming', async (_req, res) => {
      try {
        const events = isCalendarConfigured()
          ? await listUpcomingEvents(config.prepWindowMinutes)
          : await listUpcomingMicrosoft365Events(config.prepWindowMinutes);
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

    // Outlook mail ingestion via the Microsoft 365 Claude connector — writes
    // raw rows into the same external_messages table the manual daily-agent
    // path (docs/EXTERNAL_INGESTION_PROMPT.md) writes to; a separate
    // background timer (see start()) also calls this automatically every
    // config.emailSyncPollMinutes. This route lets Settings' "Sync now"
    // button trigger an out-of-cadence run the same way "Index codebase"/
    // "Index communications" do.
    app.post('/api/email/sync', (_req, res) => {
      if (this.emailSyncInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runEmailSync();
      res.json({ started: true });
    });

    app.get('/api/email/status', (_req, res) => {
      res.json({
        inProgress: this.emailSyncInProgress,
        lastSyncAt: this.emailSyncLastSyncAt,
        lastError: this.emailSyncLastError,
      });
    });

    // Teams chat ingestion via the Microsoft 365 Claude connector — replaces
    // the old headless-Chromium DOM scrape (teamsPlaywright.ts, deleted).
    // Same shape as the email-sync routes above: a background timer (see
    // start()) also calls this automatically every config.teamsSyncPollMinutes.
    app.post('/api/teams/sync', (_req, res) => {
      if (this.teamsSyncInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runTeamsSync();
      res.json({ started: true });
    });

    app.get('/api/teams/status', (_req, res) => {
      res.json({
        inProgress: this.teamsSyncInProgress,
        lastSyncAt: this.teamsSyncLastSyncAt,
        lastError: this.teamsSyncLastError,
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
      if (this.calendarImportInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runCalendarImport();
      res.json({ started: true });
    });

    app.get('/api/calendar/import/status', (_req, res) => {
      res.json({
        configured: config.calendarImportEnabled,
        inProgress: this.calendarImportInProgress,
        lastRunAt: this.calendarImportLastRunAt,
        lastError: this.calendarImportLastError,
      });
    });

    // "My Plate" — the unified cross-source task board (src/orchestrator/taskSync.ts).
    app.get('/api/plate', (_req, res) => {
      res.json(getOpenTasks());
    });

    // Manual out-of-cadence trigger, same shape as /api/calendar/import above.
    app.post('/api/plate/sync', (_req, res) => {
      if (this.orchestratorSyncInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runOrchestratorSync();
      res.json({ started: true });
    });

    app.post('/api/jenkins/poll', (_req, res) => {
      if (this.jenkinsSyncInProgress) {
        res.json({ started: false, alreadyRunning: true });
        return;
      }
      this.runJenkinsSync();
      res.json({ started: true });
    });

    app.get('/api/plate/status', (_req, res) => {
      res.json({
        inProgress: this.orchestratorSyncInProgress,
        lastRunAt: this.orchestratorLastRunAt,
        lastError: this.orchestratorLastError,
      });
    });

    // The morning digest (src/summarization/morningBriefing.ts) — generated
    // at most once per day by checkMorningBriefing() below. null until the
    // first business-hours tick of the day has run.
    app.get('/api/plate/briefing', (_req, res) => {
      res.json(getTodaysBriefing() ?? null);
    });

    // Cross-kind "everything still awaiting your approval" — the end-of-day
    // review queue (blueprint §9). getActiveDraftsByStatus already exists
    // for startup reconciliation (reconcileStuckDrafts); this just exposes
    // the same primitive over HTTP for the Dashboard's review-queue modal.
    app.get('/api/drafts/pending', (_req, res) => {
      const drafts = getActiveDraftsByStatus(['ready', 'refining']);
      res.json(drafts.map((d) => ({ id: d.id, kind: d.kind, subjectKind: d.subjectKind, subjectId: d.subjectId, createdAt: d.createdAt })));
    });

    app.post('/api/plate/:id/dismiss', (req, res) => {
      dismissTask(Number(req.params.id));
      this.broadcast({ type: 'plate-updated' });
      res.json({ dismissed: true });
    });

    // Dashboard kanban drag-and-drop — moves a task between columns.
    app.post('/api/plate/:id/status', (req, res) => {
      const boardStatus = req.body?.boardStatus;
      if (!['todo', 'in_progress', 'done'].includes(boardStatus)) {
        res.status(400).json({ error: 'boardStatus must be one of: todo, in_progress, done' });
        return;
      }
      updateTaskBoardStatus(Number(req.params.id), boardStatus);
      this.broadcast({ type: 'plate-updated' });
      res.json({ updated: true });
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

    app.get('/api/sessions/:id/audio-overview', (req, res) => {
      res.json({ overview: getAudioOverviewForSession(req.params.id) || null });
    });

    app.get('/api/audio-overviews/:id/audio', (req, res) => {
      const overview = getAudioOverview(Number(req.params.id));
      if (!overview || !fs.existsSync(overview.audioPath)) {
        res.status(404).json({ error: 'Unknown or missing audio overview.' });
        return;
      }
      res.setHeader('Content-Type', 'audio/wav');
      fs.createReadStream(overview.audioPath).pipe(res);
    });

    // Async started/broadcast, same shape as chapters/summarize — TTS
    // generation is slow enough that this shouldn't be a synchronous
    // awaited request like /api/insights/ask is. Exactly one of
    // subject/sessionId must be given: subject spins up a new
    // sessionKind:'audioOverview' session (like Chat) and grounds via that
    // session's own activeTools fanned out through gatherAudioOverviewContext
    // (same machinery the prep workflows use); sessionId grounds in an
    // existing ended meeting's own summary + open action items.
    app.post('/api/audio-overviews', async (req, res) => {
      const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
      let sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      if (!subject && !sessionId) {
        res.status(400).json({ error: 'Provide a subject or a sessionId.' });
        return;
      }
      if (!config.geminiApiKey) {
        res.status(400).json({ error: 'GEMINI_API_KEY is not configured — see NOTES.md.' });
        return;
      }

      let subjectLabel: string;
      let activeTools: string[] | null = null;
      let gatherContext: () => Promise<string>;
      if (sessionId) {
        const session = getSession(sessionId);
        if (!session) {
          res.status(404).json({ error: 'Unknown session.' });
          return;
        }
        if (!session.endedAt) {
          res.status(409).json({ error: 'Session is still recording — stop it first.' });
          return;
        }
        const summary = getSummary(sessionId);
        if (!summary) {
          res.status(409).json({ error: 'Generate a summary for this session first.' });
          return;
        }
        subjectLabel = session.name || 'this meeting';
        const openItems = getActionItems(sessionId).filter((a) => a.status === 'open');
        const contextBlock = [
          `Overview: ${summary.overview}`,
          `Key decisions: ${summary.keyDecisions}`,
          `Discussion: ${summary.discussionTopics}`,
          `Next steps: ${summary.nextSteps}`,
          openItems.length ? `Open action items:\n${openItems.map((i) => `- ${i.description} (${i.owner || 'unowned'})`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        gatherContext = async () => contextBlock;
      } else {
        subjectLabel = subject;
        activeTools = Array.isArray(req.body?.activeTools) ? req.body.activeTools : null;
        sessionId = uuid();
        createPrepSession(sessionId, [], subject.slice(0, 80), { sessionKind: 'audioOverview', activeTools: activeTools ?? undefined });
        endSession(sessionId);
        const newSessionId = sessionId;
        gatherContext = () => gatherAudioOverviewContext(newSessionId, subject, activeTools);
      }

      res.json({ started: true, sessionId });
      this.broadcastAudioOverviewGenerating(sessionId);
      gatherContext()
        .then((contextBlock) => generateAudioOverview(subjectLabel, contextBlock))
        .then((result) => {
          // Regenerating a meeting-linked overview replaces it — delete the
          // old row + file first so it doesn't leak on disk. A fresh
          // audioOverview session never has a previous row to replace.
          const previous = getAudioOverviewForSession(sessionId);
          if (previous) {
            const oldPath = deleteAudioOverview(previous.id);
            if (oldPath) fs.rm(oldPath, { force: true }, () => {});
          }
          const dir = path.join(config.audioDir, 'overviews');
          fs.mkdirSync(dir, { recursive: true });
          const audioPath = path.join(dir, `${uuid()}.wav`);
          fs.writeFileSync(audioPath, result.audioBuffer);
          const overview = insertAudioOverview({
            sessionId,
            subjectText: subjectLabel,
            scriptText: result.scriptText,
            audioPath,
          });
          this.broadcastAudioOverviewReady(overview);
        })
        .catch((err: any) => {
          console.error('[audio-overview] generation failed:', err.message);
          this.broadcastAudioOverviewFailed(err.message, sessionId);
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

    // Same "Implement with Claude Code" engine as the action-item route
    // above, just originating from a Jira Dashboard card instead of a
    // meeting action item — startClaudeCodeTask/pollCodeChangeRequest and
    // the approve/push/discard routes below are already origin-agnostic.
    app.post('/api/plate/:id/implement', async (req, res) => {
      const taskId = Number(req.params.id);
      const task = getTaskById(taskId);
      if (!task || task.source !== 'jira') {
        res.status(404).json({ error: 'Unknown Jira task.' });
        return;
      }
      const existing = getLatestCodeChangeRequestForTask(taskId);
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
        const prompt = `Implement this Jira ticket.\n\n${task.title}${task.description ? `\n\n${task.description}` : ''}`;
        const { cliSessionId } = await startClaudeCodeTask(prompt, repoPath);
        const request = createCodeChangeRequest({ taskId, repoName, repoPath, cliSessionId });
        this.pollCodeChangeRequest(request.id).catch((err: any) => console.error('[claude-code] polling failed:', err.message));
        this.broadcast({ type: 'code-change-started', taskId, requestId: request.id });
        res.json({ started: true, requestId: request.id });
      } catch (err: any) {
        console.error('[claude-code] failed to start task:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/plate/:id/code-change', (req, res) => {
      const taskId = Number(req.params.id);
      const request = getLatestCodeChangeRequestForTask(taskId);
      res.json(request ?? null);
    });

    // The reply-draft view's conversation-context section — a task sourced
    // from teams_message/email_message carries the original message's id as
    // externalRef (see taskSync.ts), which is also external_messages.id.
    // Returns null (not 404) for a task with no matching message (e.g. any
    // other source, or a message row that's aged out) — the frontend just
    // omits the context section in that case.
    app.get('/api/plate/:id/message', (req, res) => {
      const taskId = Number(req.params.id);
      const task = getTaskById(taskId);
      if (!task || (task.source !== 'teams_message' && task.source !== 'email_message')) {
        res.json(null);
        return;
      }
      const message = getExternalMessageById(task.externalRef);
      res.json(message ?? null);
    });

    // Real PR review: checks the linked Jira ticket (+ related Confluence
    // docs) first for context, checks out the PR's actual branch into an
    // isolated worktree, then runs a read-only Claude Code review against
    // the real codebase — not just a diff string. Shown in its own dedicated
    // window (src/interface/public/index.html's #prReviewView). Findings are
    // never posted automatically — staging them into bitbucket_pr_comment
    // drafts (POST /api/pr-reviews/:id/stage below) and approving each one
    // through the generic draft gate is the only path to a real Bitbucket
    // write. Responds immediately; the real work happens in the background
    // (a single awaited claude -p call, not a detached agent — no separate
    // poll loop needed, see claudeCodeCli.ts).
    app.post('/api/plate/:id/review', async (req, res) => {
      const taskId = Number(req.params.id);
      const task = getTaskById(taskId);
      if (!task || task.source !== 'bitbucket_pr') {
        res.status(404).json({ error: 'Unknown Bitbucket task.' });
        return;
      }
      const existing = getLatestPrReviewRequestForTask(taskId);
      if (existing && existing.status === 'running') {
        res.json({ started: false, alreadyRunning: true, requestId: existing.id });
        return;
      }
      const match = task.externalRef.match(/^([^/]+)\/([^#]+)#(\d+)/);
      if (!match) {
        res.status(400).json({ error: 'Could not parse project/repo/PR id from this task.' });
        return;
      }
      const [, projectKey, repoSlug, prId] = match;
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
        const pr = await getPullRequest(projectKey, repoSlug, Number(prId));
        if (!pr.fromRefDisplayId) {
          res.status(400).json({ error: 'Could not determine the PR\'s source branch.' });
          return;
        }
        const request = createPrReviewRequest({ taskId, repoName, branchName: pr.fromRefDisplayId });
        res.json({ started: true, requestId: request.id });

        // Progress line, persisted (so reopening the window mid-run still
        // shows history-so-far) and broadcast live — the whole run is one
        // long await with no other visible signal otherwise, and it was
        // reported as looking "stuck" without this.
        const log = (message: string) => {
          appendPrReviewLog(request.id, message);
          this.broadcast({ type: 'pr-review-log', taskId, requestId: request.id, message });
        };

        (async () => {
          let worktreePath: string | null = null;
          try {
            log(`Fetched PR details — source branch "${pr.fromRefDisplayId}".`);
            log('Checking linked Jira ticket(s) and related Confluence docs…');
            const context = await gatherReviewContext(pr);
            setPrReviewContext(request.id, {
              jiraIssues: context.jiraIssues.map((i) => ({ key: i.key, summary: i.summary, status: i.status })),
              confluencePages: context.confluencePages.map((p) => ({ title: p.title })),
            });
            log(
              context.jiraIssues.length || context.confluencePages.length
                ? `Found ${context.jiraIssues.length} Jira ticket(s) and ${context.confluencePages.length} Confluence page(s).`
                : 'No linked Jira ticket or related Confluence docs found.'
            );
            log(`Checking out ${pr.fromRefDisplayId} into an isolated worktree…`);
            worktreePath = await createWorktreeForBranch(repoPath, pr.fromRefDisplayId!);
            log('Worktree ready — running the Claude Code review (this can take a few minutes)…');
            const prompt = buildReviewPrompt(pr, context);
            const result = await runClaudeCodeReview(prompt, worktreePath, { jsonSchema: REVIEW_JSON_SCHEMA, onProgress: log });
            if (result.isError || !result.structuredOutput) {
              log('Review failed.');
              markPrReviewFailed(request.id, result.isError ? result.resultText || 'Claude Code returned an error.' : 'Claude Code did not return a structured result.');
              this.broadcast({ type: 'pr-review-failed', taskId, requestId: request.id });
            } else {
              log('Review complete.');
              markPrReviewReady(request.id, result.structuredOutput);
              this.broadcast({ type: 'pr-review-ready', taskId, requestId: request.id });
            }
          } catch (err: any) {
            console.error('[pr-review] failed:', err.message);
            log(`Failed: ${err.message}`);
            markPrReviewFailed(request.id, err.message);
            this.broadcast({ type: 'pr-review-failed', taskId, requestId: request.id });
          } finally {
            if (worktreePath) {
              log('Cleaning up worktree…');
              try {
                await removeWorktree(worktreePath, repoPath);
              } catch (err: any) {
                console.error('[pr-review] failed to remove worktree:', err.message);
              }
            }
          }
        })();
      } catch (err: any) {
        console.error('[pr-review] failed to start:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/plate/:id/review', (req, res) => {
      const taskId = Number(req.params.id);
      const request = getLatestPrReviewRequestForTask(taskId);
      res.json(request ?? null);
    });

    // Idempotent: re-POSTing an already-staged review returns the existing
    // drafts rather than creating duplicates, unless ?force=1 — each of the
    // review's findings becomes its own bitbucket_pr_comment draft, gated
    // through the normal generic draft routes (/api/drafts/:id/refine|approve|discard|redo).
    app.post('/api/pr-reviews/:id/stage', async (req, res) => {
      const requestId = Number(req.params.id);
      const request = getPrReviewRequest(requestId);
      if (!request || !request.review) {
        res.status(400).json({ error: 'This review has no findings to stage yet.' });
        return;
      }
      const force = req.query.force === '1';
      const existing = getDraftsForSubjectPrefix('pr_review_request', `${requestId}:`, 'bitbucket_pr_comment');
      if (existing.length && !force) {
        res.json(existing);
        return;
      }
      try {
        const drafts = [];
        for (let findingIndex = 0; findingIndex < request.review.findings.length; findingIndex++) {
          drafts.push(await startDraft({ kind: 'bitbucket_pr_comment', subjectId: prCommentSubjectId(requestId, findingIndex) }));
        }
        res.json(drafts);
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    app.get('/api/pr-reviews/:id/comment-drafts', (req, res) => {
      const requestId = Number(req.params.id);
      res.json(getDraftsForSubjectPrefix('pr_review_request', `${requestId}:`, 'bitbucket_pr_comment'));
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
        const actionItem = request.actionItemId ? getActionItem(request.actionItemId) : undefined;
        const task = request.taskId ? getTaskById(request.taskId) : undefined;
        const commitMessage = `Implement: ${(actionItem?.description ?? task?.title ?? 'action item').slice(0, 200)}`;
        await applyCodeChangeToRepo(request.diff ?? '', request.repoPath, commitMessage);
        markCodeChangeApplied(id);
        this.broadcast({ type: 'code-change-applied', actionItemId: request.actionItemId, taskId: request.taskId, requestId: id });
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
        this.broadcast({ type: 'code-change-pushed', actionItemId: request.actionItemId, taskId: request.taskId, requestId: id });
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
        this.broadcast({ type: 'code-change-discarded', actionItemId: request.actionItemId, taskId: request.taskId, requestId: id });
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
      // deleteSession() below removes the DB row; the file it points at has
      // to be removed separately (same reason the session's own .wav is
      // handled here rather than inside that DB-only transaction).
      const existingOverview = getAudioOverviewForSession(sessionId);
      if (existingOverview) {
        fs.rm(existingOverview.audioPath, { force: true }, (err) => {
          if (err) console.error('[delete] failed to remove audio overview file:', err.message);
        });
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
        res.status(500).json({ error: cleanGeminiErrorMessage(err) });
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

    this.registerDraftRoutes(app);
    this.registerDevCycleRoutes(app);

    this.httpServer = http.createServer(app);
    this.wss = new WebSocketServer({ server: this.httpServer });

    setDraftBroadcast((event) => this.broadcast(event));
    reconcileStuckDrafts().catch((err: any) => console.error('[drafts] failed to reconcile stuck drafts on startup:', err.message));

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
            resumeSessionId: typeof msg.resumeSessionId === 'string' ? msg.resumeSessionId : undefined,
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
            const text = msg.text.trim();
            state.session.sendText(text);
            state.lastActivityAt = Date.now();
            // Typed text never generates an inputTranscript event (that's
            // audio-transcription-only) — persist it directly instead of
            // relying on the debounced spoken-turn buffer, since it's
            // already a complete, ready turn with nothing to accumulate.
            state.persistTurn?.('You', text);
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
    chatOptions?: { name?: string; languageCode?: string; activeTools?: string[]; resumeSessionId?: string }
  ): Promise<void> {
    if (this.voiceSessions.has(client)) return;
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

    // Resuming an already-started (now ended) chat/practice session — a
    // distinct concept from sourceSessionId (practice's *originating
    // meeting*, only relevant for a first run). Reuses that session's own
    // stored tool selection rather than chatOptions.activeTools, which the
    // "click Resume" UI has no fresh tool-picker to populate.
    const resumeSession_ = chatOptions?.resumeSessionId ? getSession(chatOptions.resumeSessionId) : undefined;
    if (chatOptions?.resumeSessionId && !resumeSession_) throw new Error('Unknown session to resume.');

    // A chat session created via the New Session modal's "Chat with AI"
    // button carries its own explicit tool selection (chatOptions.activeTools,
    // possibly an empty array — "no tools", a real choice) — otherwise (the
    // sidebar mic icon, or practice mode) fall back to the global
    // Settings > Voice chat tools default, same as always. Either way,
    // still filtered down to whichever are actually configured — picking a
    // tool here does nothing on its own if it has no real credentials/path.
    const requestedTools: string[] = resumeSession_
      ? resumeSession_.activeTools ?? config.voiceToolKeys
      : (mode === 'chat' ? chatOptions?.activeTools : undefined) ?? config.voiceToolKeys;
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

    if (resumeSession_) {
      // Gemini Live has no cross-connection memory of its own — "resuming"
      // means a brand-new Live connection, seeded with the prior transcript,
      // reusing the same session id/row so new turns keep appending to it
      // (same "new pipeline, same persisted row" pattern meeting resume
      // already uses via resumeSession() clearing ended_at).
      persistedSessionId = resumeSession_.id;
      persistedSessionKind = resumeSession_.sessionKind === 'practice' ? 'practice' : 'chat';
      resumeSession(persistedSessionId);
      const priorTranscript = toPlainText(getSegmentsForSession(persistedSessionId));
      systemInstruction = buildResumeInstruction(priorTranscript);
    } else if (mode === 'practice') {
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
    let persistTurn: ((speaker: string, text: string) => void) | undefined;

    if (persistedSessionId) {
      const finalSessionId = persistedSessionId;
      const assistantLabel = persistedSessionKind === 'practice' ? 'Practice Partner' : 'Assistant';
      const sessionStart = Date.now();
      // Resuming continues the timeline rather than restarting it at 0 —
      // otherwise a resumed round's segments would sort before the prior
      // round's later ones once displayed (getSegmentsForSession orders by
      // start_ms), scrambling the transcript's actual chronology. baseOffsetMs
      // (not just lastEndMs) has to carry forward too, since `now` below is
      // computed relative to *this* connection's own sessionStart — without
      // adding it back in, a resumed round's endMs would be smaller than its
      // own startMs (this round's tiny elapsed-so-far vs. the prior round's
      // already-large lastEndMs).
      const priorSegments = resumeSession_ ? getSegmentsForSession(finalSessionId) : [];
      const baseOffsetMs = priorSegments.length ? Math.max(...priorSegments.map((s) => s.endMs)) : 0;
      let lastEndMs = baseOffsetMs;
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

      // Broadcasting the same 'segment' shape/message a live meeting's
      // transcript uses lets the main panel render chat/practice turns via
      // the exact same renderSegment() path — no separate rendering model.
      persistTurn = (speaker: string, text: string) => {
        if (!text.trim()) return;
        const now = baseOffsetMs + (Date.now() - sessionStart);
        const segment = { sessionId: finalSessionId, speaker, startMs: lastEndMs, endMs: now, text: text.trim(), isFinal: true };
        insertFinalSegment(segment);
        this.broadcast({ type: 'segment', segment });
        lastEndMs = now;
      };
      flushTranscript = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        persistTurn!('You', inputBuffer);
        persistTurn!(assistantLabel, outputBuffer);
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
    this.voiceSessions.set(client, { session: liveSession, persistedSessionId, persistedSessionKind, flushTranscript, persistTurn, lastActivityAt: Date.now() });

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
      this.checkMorningBriefing();
    }, 20_000);
    this.voiceIdleCheckTimer = setInterval(() => this.checkIdleVoiceSessions(), 30_000);
    this.emailSyncTimer = setInterval(() => { if (isWithinBusinessHours()) this.runEmailSync(); }, config.emailSyncPollMinutes * 60_000);
    this.calendarImportTimer = setInterval(() => this.runCalendarImport(), config.calendarImportPollMinutes * 60_000);
    this.orchestratorSyncTimer = setInterval(() => { if (isWithinBusinessHours()) this.runOrchestratorSync(); }, config.orchestratorPollMinutes * 60_000);
    this.jenkinsSyncTimer = setInterval(() => { if (isWithinBusinessHours()) this.runJenkinsSync(); }, config.jenkinsPollMinutes * 60_000);
    this.teamsSyncTimer = setInterval(() => { if (isWithinBusinessHours()) this.runTeamsSync(); }, config.teamsSyncPollMinutes * 60_000);
  }

  stop(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.voiceIdleCheckTimer) clearInterval(this.voiceIdleCheckTimer);
    if (this.emailSyncTimer) clearInterval(this.emailSyncTimer);
    if (this.calendarImportTimer) clearInterval(this.calendarImportTimer);
    if (this.orchestratorSyncTimer) clearInterval(this.orchestratorSyncTimer);
    if (this.jenkinsSyncTimer) clearInterval(this.jenkinsSyncTimer);
    if (this.teamsSyncTimer) clearInterval(this.teamsSyncTimer);
    for (const [client] of this.voiceSessions) this.stopVoiceSession(client);
    this.wss.close();
    this.httpServer.close();
  }

  /**
   * Fire-and-forget — called both by the poll timer and the manual "Sync
   * now" route. Pulls Outlook mail via the Microsoft 365 Claude connector
   * (outlookMailSync.ts) — no "is this configured" check the way the old
   * direct-Graph integration needed, since the connector is a machine-level
   * `claude mcp` registration outside Speako's own config surface; a genuine
   * dispatch failure just surfaces as a caught error below.
   */
  private runEmailSync(): void {
    if (this.emailSyncInProgress) return;
    this.emailSyncInProgress = true;
    syncOutlookMail()
      .then(async (result) => {
        this.emailSyncLastSyncAt = new Date().toISOString();
        this.emailSyncLastError = null;
        console.log(`[email-sync] synced ${result.emailCount} email(s)`);
        // Chain email triage + task reflection onto the sync that just ran —
        // same "don't wait for the next orchestrator tick" convention as
        // runTeamsSync().
        await runEmailTriage();
        await syncTasks();
        this.broadcast({ type: 'plate-updated' });
      })
      .catch((err: any) => {
        this.emailSyncLastError = err.message;
        console.error('[email-sync] sync failed:', err.message);
      })
      .finally(() => {
        this.emailSyncInProgress = false;
      });
  }

  /**
   * Fire-and-forget, called both by the poll timer and the manual "Sync
   * calendar" route. Broadcasts one 'calendar-session-created' event per
   * newly-imported session so the sidebar and calendar view can refresh
   * without a manual reload.
   */
  private runCalendarImport(): void {
    if (this.calendarImportInProgress || !config.calendarImportEnabled) return;
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
   * Fire-and-forget, called both by the poll timer (config.teamsSyncPollMinutes)
   * and the manual "Sync now" route/button — same dual-trigger shape as
   * runEmailSync/runCalendarImport above. Pulls new messages via the
   * Microsoft 365 Claude connector (teamsConnectorSync.ts), triages them
   * (draft a reply if directed at you, otherwise just summarize —
   * src/communications/teamsMessageTriage.ts), then reflects them into the
   * unified tasks board immediately rather than waiting for the next
   * orchestrator tick.
   */
  private runTeamsSync(): void {
    if (this.teamsSyncInProgress) return;
    this.teamsSyncInProgress = true;
    syncTeamsMessages()
      .then(async (result) => {
        console.log(`[teams-sync] synced ${result.messageCount} message(s)`);
        const triageResult = await runTeamsMessageTriage();
        console.log(`[teams-sync] triaged ${triageResult.triaged} message(s)`);
        await syncTasks();
        this.teamsSyncLastSyncAt = new Date().toISOString();
        this.teamsSyncLastError = null;
        this.broadcast({ type: 'plate-updated' });
      })
      .catch((err: any) => {
        this.teamsSyncLastError = err.message;
        console.error('[teams-sync] sync failed:', err.message);
      })
      .finally(() => {
        this.teamsSyncInProgress = false;
      });
  }

  /**
   * Fire-and-forget, called both by the poll timer and the manual "Sync
   * now" route (POST /api/plate/sync) — same shape as runCalendarImport/
   * runEmailSync above. syncTasks() already isolates per-source failures
   * (Promise.allSettled), so this outer catch only ever fires on something
   * syncTasks() itself couldn't recover from (it shouldn't, in practice).
   */
  private runOrchestratorSync(): void {
    if (this.orchestratorSyncInProgress) return;
    this.orchestratorSyncInProgress = true;
    syncTasks()
      .then((result) => {
        this.orchestratorLastRunAt = new Date().toISOString();
        this.orchestratorLastError = result.failed.length ? `Sources failed: ${result.failed.join(', ')}` : null;
        this.broadcast({ type: 'plate-updated' });
      })
      .catch((err: any) => {
        this.orchestratorLastError = err.message;
        console.error('[orchestrator] sync failed:', err.message);
      })
      .finally(() => {
        this.orchestratorSyncInProgress = false;
      });
  }

  /**
   * Fire-and-forget — same dual-trigger shape (poll timer + manual route) as
   * runOrchestratorSync/runEmailSync. Skipped silently when Jenkins isn't
   * configured (pollJenkinsBuilds itself no-ops in that case) — a poller
   * ticking every few minutes logging "not configured" would be noise for
   * the majority of installs without a Jenkins instance set up. Re-syncs My
   * Plate immediately after so a freshly-observed red build doesn't wait for
   * the separate, independently-scheduled orchestrator poll to show up.
   */
  private runJenkinsSync(): void {
    if (this.jenkinsSyncInProgress) return;
    this.jenkinsSyncInProgress = true;
    pollJenkinsBuilds((event) => this.broadcast(event))
      .then(() => syncTasks())
      .then(() => this.broadcast({ type: 'plate-updated' }))
      .catch((err: any) => console.error('[jenkins] poll failed:', err.message))
      .finally(() => {
        this.jenkinsSyncInProgress = false;
      });
  }

  /** Thin wrapper so existing call sites keep working unchanged — the actual polling loop now lives in src/integrations/codeChangePoller.ts, extracted so a draft kind's execute() (src/drafts/kinds/devPlanDraft.ts) can trigger the same loop without needing access to this instance. */
  private pollCodeChangeRequest(requestId: number): Promise<void> {
    return pollCodeChangeRequest(requestId, (event) => this.broadcast(event));
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
   * Generates the morning digest at most once per calendar day — folded into
   * the existing 20s scheduleTimer tick rather than its own timer, since
   * checking "does today's row exist yet" is a single cheap indexed SELECT
   * (getTodaysBriefing). Gated on business hours the same way every other
   * automatic-only (not manual-route) poller is, so it doesn't fire at 2am
   * the first time the server happens to tick after midnight.
   */
  private checkMorningBriefing(): void {
    if (this.morningBriefingInProgress || !isWithinBusinessHours() || getTodaysBriefing()) return;
    this.morningBriefingInProgress = true;
    buildMorningBriefing()
      .then((content) => {
        saveTodaysBriefing(content);
        this.broadcast({ type: 'plate-updated' });
      })
      .catch((err: any) => console.error('[morning-briefing] failed to generate:', err.message))
      .finally(() => {
        this.morningBriefingInProgress = false;
      });
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

  /** Every audio overview is session-backed now (subject-driven ones spin up a fresh sessionKind:'audioOverview' session first) — sessionId is always that session's id, whether it's a brand-new subject-driven session or an existing meeting being re-recapped. */
  broadcastAudioOverviewGenerating(sessionId: string): void {
    this.broadcast({ type: 'audio-overview-generating', sessionId });
  }

  broadcastAudioOverviewReady(overview: AudioOverview): void {
    this.broadcast({ type: 'audio-overview-ready', overview });
  }

  broadcastAudioOverviewFailed(error: string, sessionId: string): void {
    this.broadcast({ type: 'audio-overview-failed', error, sessionId });
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

  /**
   * The generic draft -> refine -> approve -> execute -> redo gate (src/drafts/)
   * — every write-surface migrated onto it (see draftService.ts's header
   * comment) shares these same eight routes rather than each growing its
   * own approve/refine/redo endpoints. Kind-specific behavior lives entirely
   * in each kind's DraftHandler (src/drafts/kinds/), never here.
   */
  private registerDraftRoutes(app: express.Express): void {
    const handleDraftError = (err: any, res: express.Response) => {
      if (err instanceof DraftConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error('[drafts] request failed:', err.message);
      res.status(500).json({ error: cleanGeminiErrorMessage(err) });
    };

    app.post('/api/drafts', async (req, res) => {
      const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
      const subjectId = req.body?.subjectId;
      if (!kind || subjectId === undefined || subjectId === null) {
        res.status(400).json({ error: 'kind and subjectId are required.' });
        return;
      }
      try {
        const draft = await startDraft({ kind, subjectId });
        res.json(draft);
      } catch (err: any) {
        handleDraftError(err, res);
      }
    });

    app.get('/api/drafts/:id', (req, res) => {
      const draft = getDraft(Number(req.params.id));
      if (!draft) {
        res.status(404).json({ error: 'Unknown draft.' });
        return;
      }
      res.json(draft);
    });

    app.get('/api/drafts/:id/revisions', (req, res) => {
      res.json(getDraftRevisions(Number(req.params.id)));
    });

    // Returns null (not 404) when absent — mirrors GET /api/plate/:id/code-change's
    // convention, since "no draft yet" is a normal, expected state here.
    app.get('/api/drafts/for/:subjectKind/:subjectId', (req, res) => {
      const subjectKind = req.params.subjectKind as DraftSubjectKind;
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      if (kind) {
        res.json(getLatestDraftForSubject(subjectKind, req.params.subjectId, kind) ?? null);
        return;
      }
      res.json(getDraftsForSubject(subjectKind, req.params.subjectId));
    });

    app.post('/api/drafts/:id/refine', async (req, res) => {
      const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
      if (!instruction) {
        res.status(400).json({ error: 'An instruction is required.' });
        return;
      }
      try {
        const draft = await refineDraft(Number(req.params.id), instruction);
        res.json(draft);
      } catch (err: any) {
        handleDraftError(err, res);
      }
    });

    app.patch('/api/drafts/:id/content', (req, res) => {
      if (req.body?.content === undefined) {
        res.status(400).json({ error: 'content is required.' });
        return;
      }
      try {
        const draft = editDraftContent(Number(req.params.id), req.body.content);
        res.json(draft);
      } catch (err: any) {
        handleDraftError(err, res);
      }
    });

    app.post('/api/drafts/:id/approve', async (req, res) => {
      const gate = typeof req.body?.gate === 'string' ? req.body.gate : undefined;
      try {
        const draft = await approveDraftGate(Number(req.params.id), gate);
        res.json(draft);
      } catch (err: any) {
        handleDraftError(err, res);
      }
    });

    app.post('/api/drafts/:id/discard', async (req, res) => {
      try {
        const draft = await discardDraft(Number(req.params.id));
        res.json(draft);
      } catch (err: any) {
        handleDraftError(err, res);
      }
    });

    app.post('/api/drafts/:id/redo', async (req, res) => {
      const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : undefined;
      try {
        const draft = await redoDraft(Number(req.params.id), instruction);
        res.json(draft);
      } catch (err: any) {
        handleDraftError(err, res);
      }
    });
  }

  /**
   * The Jira -> branch -> plan -> implement dev cycle (src/dev/). Branch
   * creation and the plan-before-code step themselves are generic draft
   * kinds (git_branch_create/dev_plan, src/drafts/kinds/) reachable through
   * the routes registered above — these two routes are just for creating a
   * cycle in the first place and reading its current state back for the UI.
   */
  private registerDevCycleRoutes(app: express.Express): void {
    app.post('/api/dev-cycles', async (req, res) => {
      const ticketKey = typeof req.body?.ticketKey === 'string' ? req.body.ticketKey.trim() : '';
      const taskId = typeof req.body?.taskId === 'number' ? req.body.taskId : undefined;
      const branchType: BranchType = (['feature', 'bugfix', 'hotfix', 'chore'] as const).includes(req.body?.branchType) ? req.body.branchType : 'feature';
      if (!ticketKey) {
        res.status(400).json({ error: 'ticketKey is required.' });
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
      const existing = getActiveDevCycleForTicket(ticketKey);
      if (existing) {
        res.json(existing);
        return;
      }
      if (!isJiraConfigured()) {
        res.status(400).json({ error: 'Jira is not configured — see NOTES.md.' });
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
        const ticket = await getJiraIssueDetail(ticketKey);
        if (!ticket) {
          res.status(404).json({ error: `Jira issue ${ticketKey} was not found.` });
          return;
        }
        // A cycle only ever gets created to start work on a ticket — the
        // real lifecycle-state enforcement (validating this against the
        // ticket's actual live status/transitions) is the Jira lifecycle
        // engine's job (src/dev/lifecycle.ts).
        const cycle = createDevCycle({ ticketKey, taskId, repoName, repoPath, branchType, baseBranch: config.devTrunkBranch, lifecycleState: 'Dev Ready' });
        res.json(cycle);
      } catch (err: any) {
        res.status(502).json({ error: err.message });
      }
    });

    app.get('/api/dev-cycles/:id', (req, res) => {
      const cycle = getDevCycle(Number(req.params.id));
      if (!cycle) {
        res.status(404).json({ error: 'Unknown dev cycle.' });
        return;
      }
      res.json(cycle);
    });

    app.get('/api/dev-cycles/for-ticket/:ticketKey', (req, res) => {
      res.json(getActiveDevCycleForTicket(req.params.ticketKey) ?? null);
    });
  }

  private broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }
}

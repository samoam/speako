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
} from '../storage/segmentRepository';
import { diarizeSession, deleteUploadedAudio } from '../diarization/diarize';
import { SUPPORTED_LANGUAGES } from '../languages';
import { toPlainText } from '../transcriptFormat';
import { summarizeSession, extractActionItems } from '../summarization/summarize';
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
import { listUpcomingEvents } from '../integrations/googleCalendar';
import { writeSummaryFactsToMem0 } from '../prep/writeMemFacts';
import { analyzeConversation } from '../coaching/analyzeConversation';
import { saveCoachingFeedback, getCoachingFeedback, CoachingFeedback } from '../storage/coachingRepository';
import { runCodebaseIndex } from '../codebase/indexCodebase';
import { getIndexedRepoSummary } from '../storage/codeRepository';
import { updateSettings } from '../settingsStore';
import { ALL_TOOL_KEYS } from '../tools/activeTools';
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

const SETTINGS_FIELDS = [
  'geminiApiKey',
  'geminiModel',
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

type StartHandler = (languageCode?: string, name?: string, existingSessionId?: string) => string;
type StopHandler = () => void;

export class InterfaceServer {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private currentSessionId: string | null = null;
  private onStartHandler: StartHandler | null = null;
  private onStopHandler: StopHandler | null = null;
  private codebaseIndexInProgress = false;
  private communicationsIndexInProgress = false;

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
        mem0: isMem0Configured(),
        ragCloud: isRagConfigured(),
        localCodebase: isLocalCodebaseConfigured(),
        webSearch: isWebFactCheckConfigured(),
        email: hasAnyExternalMessages('email'),
        teams: hasAnyExternalMessages('teams'),
      });
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
      const sessionId = this.onStartHandler(languageCode, name, existingSessionId);
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

      const sessionId = uuid();
      createPrepSession(sessionId, languageCodes, name, { sessionType: 'work', meetingType, calendarEventId, activeTools });

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
    app.get('/api/calendar/upcoming', async (_req, res) => {
      try {
        const events = await listUpcomingEvents(config.prepWindowMinutes);
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
      Promise.all([summarizeSession(segments), extractActionItems(segments)])
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
    });
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
  }

  stop(): void {
    this.wss.close();
    this.httpServer.close();
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

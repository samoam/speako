# Speako — Documentation

A personal, local-first AI meeting assistant. It listens to live meetings (microphone + optionally system/loopback audio), transcribes them in real time with speaker separation, and layers a large set of reasoning features on top — live sentiment, proactive trigger detection, fact-checking against your own tools, in-meeting Q&A, pre-meeting prep briefs, post-meeting summarization/coaching/audio overviews, cross-session Q&A, and one-click follow-through on action items (including real Jira/Confluence writes and dispatching code changes to Claude Code).

Everything runs on your own machine against your own cloud accounts/tokens — there is no Speako backend service. "The server" is a single Node process you run locally; the browser is a thin WebSocket-connected display client with no direct access to the audio stream or any credentials.

This document describes what Speako does and how it's built, as of the current codebase. For the detailed build log — every API gotcha, empirically-confirmed quirk, and the reasoning behind non-obvious design decisions — see [NOTES.md](./NOTES.md). For setup instructions, see [README.md](./README.md).

---

## 1. Core concepts

### Sessions

Everything in Speako revolves around a **session** — one row in the `sessions` table, with a transcript, and whatever else got generated for it (summary, action items, coaching feedback, chapters, an audio overview, etc.). Sessions are distinguished along two independent axes:

- **`sessionType`**: `'work'` (the only value anything creates today — Speako is deliberately work-only; `'personal'` is kept only as a historical value for old rows) or `'personal'`.
- **`sessionKind`**: what *kind* of session this is, driving the sidebar's history tabs and a lot of UI/behavior gating:
  - **`meeting`** (default) — a real recorded meeting. Gets pre-meeting prep, Start/Pause/Resume/Stop controls, diarization, summarization, coaching, chapters, per-meeting audio overviews.
  - **`chat`** — a live voice (or typed) conversation with the AI (Gemini Live API), persisted as a real session/transcript just like a meeting, but with no recording controls, no prep, no coaching.
  - **`practice`** — a roleplay/rehearsal session (same live-voice mechanism as chat) that gets coaching feedback on stop, since the point is to critique a rehearsal, not log a Q&A.
  - **`audioOverview`** — a session whose entire purpose is a generated two-host spoken discussion of a subject (see §4.11 below). Created instantly (no recording phase), shows only its own "Overview" tab.

A session's kind is set once at creation and never changes. The sidebar's `Meetings / Practice / Chat / Audio Overview` tabs are a client-side filter over one already-fetched `sessions` list, not separate server queries.

### On-demand vs. automatic

Every feature that costs real API money or uploads real audio is **explicitly triggered by the user**, never automatic:
- Diarization, summarization, coaching feedback, chapters, audio overviews, pre-meeting prep (re-runs), codebase indexing.

Features that only process text already visible/stored run **automatically while recording**, since an "analyze after the fact" button wouldn't serve their purpose:
- Sentiment scoring, trigger detection → suggestions, the meeting-state rolling summary, the live waveform, RAG indexing (on session stop).

Almost every automatic feature has its own `.env` toggle (`SENTIMENT_ENABLED`, `TRIGGER_DETECTION_ENABLED`, `RAG_ENABLED`, `LIVE_QA_ENABLED`, `MEETING_STATE_ENABLED`, `WAVEFORM_ENABLED`, `PREP_ENABLED`, `CALENDAR_IMPORT_ENABLED`) plus a per-session "heavy features" checklist in the New Session modal, so any one of them can be turned off without losing the rest.

### Tool gating (`activeTools`)

A session can restrict which external tools (Jira, Confluence, Bitbucket, Bitbucket PR reviews, mem0, MyRAG, local codebase, email, Teams, web search) it's allowed to query — stored as `activeTools: string[] | null` on the session row (`null` = every globally-configured tool is active). This is the same mechanism behind:
- Pre-meeting prep workflows' source gating.
- Live chat's function-calling tool set (a narrower subset — no email/Teams/web search).
- The Audio Overview session type's context gathering (§4.11).

Set once at session creation (New Session modal's "Tools for this session" checklist), editable later via the session's "Tools for this session" popover.

---

## 2. Features

### 2.1 Live capture & transcription

- **Audio capture**: SoX, spawned as a subprocess (not a native Node addon), captures mic audio and — if `SYSTEM_AUDIO_DEVICE` is configured (a virtual audio cable, since Windows has no built-in loopback device) — a second system/tab-audio channel, sample-aligned via SoX's `-M` mode.
- **Transcription**: Google Cloud Speech-to-Text v2, `chirp_3` model, streamed via the internal `_streamingRecognize()` method (the public `streamingRecognize()` wrapper is broken for v2 — it never sets the required `recognizer` field). Streams restart every `STREAM_RESTART_SECONDS` (default 240s) as a proactive resilience measure; segment timestamps are stitched across restarts.
- **Supported languages**: English (US/UK), French (France/Quebec), Arabic (Morocco — Preview quality). `SPEECH_LANGUAGE_CODES=auto` lets chirp_3 auto-detect the dominant language.
- **Domain-vocabulary biasing** via a phrase-hints list (`config/phrase-hints.json`) fed into Speech Adaptation.
- **Local WAV recording**: every session's raw audio is recorded to `data/audio/<sessionId>.wav` regardless of anything else — cheap, local, no cloud involved, and the source material for on-demand diarization.
- **Live audio waveform**: the server downsamples each raw PCM chunk into a compact min/max envelope and broadcasts it over the WebSocket; the browser draws a scrolling oscillogram next to the session title, visible across every tab, only while viewing the session currently recording.
- **In-session Start/Pause/Resume/Stop controls**: a `#recordingControls` cluster in the main panel (in addition to the sidebar's Start/Resume and the header's global Stop). Pause closes the underlying Speech-to-Text stream outright (no audio buffering) and freezes the recording's audio-time axis — resuming picks the timestamp axis back up as if the paused stretch never happened.
- **Transient-stream error visibility**: a dead/failed transcription stream now surfaces a red banner above the transcript (instead of silently producing an empty transcript) via `broadcastTranscriptionError` — clears automatically once a segment renders again.

### 2.2 Speaker separation & diarization

- **Live**: channel-based, not ML diarization — mic → "You", system/loopback → "Others". Distinguishes you from everyone else on the call, but not between multiple remote participants sharing the system-audio channel.
- **On-demand ("Identify speakers")**: `POST /api/sessions/:id/diarize` uploads the session's WAV to a GCS bucket and runs Speech-to-Text v2's `BatchRecognize` with `diarizationConfig` (true ML diarization — only available in batch mode, not streaming, for any current Google STT model), replacing the live "You"/"Others" labels with real "Speaker 1"/"Speaker 2"/... labels, broadcast live so an open tab updates without a refresh.
  - Retries automatically (up to 5 attempts, growing backoff, covering both the initial call and the long-running operation) on Google's intermittent "Config contains unsupported fields" error, which can be transient GCS read-after-write propagation lag.
  - That same error can also be a genuine, non-transient rejection when a session's language code isn't one Chirp 3 supports for diarization (e.g. a narrow regional/dialect code) — the error message explains this possibility explicitly rather than just repeating Google's opaque text.

### 2.3 Live intelligence (automatic during recording)

- **Sentiment**: Google Cloud Natural Language `analyzeSentiment` on each finalized segment (text-based, not vocal tone) — feeds tone coloring in the UI and the tone-shift trigger category.
- **Trigger detection** — five categories, each with its own confidence threshold, per-category cooldown, and a shared overall rate limit:
  | Category | Detection method |
  |---|---|
  | `factual_claim` | Gemini classification of a small rolling transcript window |
  | `decision_point` | Gemini classification |
  | `vagueness` | Gemini classification (a commitment with no owner/deadline) |
  | `tone_shift` | Rolling sentiment-average delta — no LLM call |
  | `unanswered_question` | Timer — a question with no follow-up within a configurable window |
  | `code_reference` | A keyword heuristic (`looksCodeRelated()`) — fires unconditionally, same principle as `factual_claim` |

  The Stage-1 classifier deliberately only sees a small window, not the whole meeting or the meeting-state summary — a fast, cheap, intentionally stateless filter.
- **Suggestions**: one Gemini call per fired trigger, grounded in RAG-retrieved past-meeting excerpts (for `factual_claim`, suppressed outright if nothing relevant is found) or the local codebase index (for `code_reference`), plus the meeting-state rolling summary/open-items to suppress duplicate or already-resolved suggestions.
- **Fact-checking** (`factual_claim` only): checked against Bitbucket (only when the claim looks code-related), Jira, Confluence, then a Gemini-Google-Search web fallback if nothing internal was confident. Only `conflict` verdicts surface as a card; every attempt shows an inline status badge. **Edit-and-recheck**: the exact claim text is editable inline (fixes transcription typos) and re-runs the full pipeline against the corrected text.
- **Meeting-state layer**: one row per session — a rolling summary (merged, not appended) and an open-items registry, updated every `MEETING_STATE_UPDATE_EVERY_SEGMENTS` (default 6) finalized segments. Feeds suggestion suppression, fact-check context, and live Q&A — deliberately *not* fed into Stage-1 trigger classification.
- **Live Q&A**: a typed question, answered from RAG + the meeting-state summary + the full live transcript so far + Bitbucket/Jira/Confluence/web, with source attribution.
- **RAG corpus**: every stopped session's transcript is chunked and embedded (`gemini-embedding-001`) into `corpus_chunks`; retrieval is brute-force cosine similarity in SQLite (no external vector DB, by design, at personal-history scale).

### 2.4 Post-meeting features (on-demand)

- **Summarization**: overview, key decisions, discussion topics, next steps, plus extracted action items (owner/due date/confidence: `explicit`/`inferred`/`manual`), via Gemini.
- **Manual action items**: add one by hand (owner/due date optional) — regenerating the AI summary never deletes manually-added items (they carry `confidence: 'manual'`, explicitly excluded from the AI-regeneration delete).
- **Action item types**, each with a one-click, always-review-before-submit follow-through:
  | Type | Action |
  |---|---|
  | `email` | Opens a `mailto:` link, AI-drafted subject/body |
  | `jira` | AI-drafted issue type/title/description (+ status transition if an existing key is detected) → a small dialog → **real** `jira_create_issue`/`jira_update_issue` write via MCP |
  | `confluence` | AI-drafted title/content → a small dialog → **real** `confluence_create_page`/`confluence_update_page` write via MCP |
  | `code_change` | Dispatches to "Implement with Claude Code" (§2.7) |
  | `schedule_meeting` | AI-drafted title/details → Google Calendar's prefill deep link |
  | `teams_message` | AI-drafted chat-toned message → Teams deep link |
  | `reminder` | Schedules a browser `Notification` at 9am on the due date (client-only) |
  | `todo` / `general` | Categorization only, no action button |

  Email/Teams/schedule-meeting are deliberately deep-links only — never sent/created by Speako itself. Jira/Confluence are the only types that perform a **real** external write, and only after explicit per-item review/edit/confirm in a dialog; a successful write is recorded (`action_items.external_ref`) and shown as a clickable "PROJ-42 created ↗" link.
- **Coaching feedback**: on-demand analysis of communication patterns (used for both real meetings and practice-roleplay sessions).
- **Chapters**: Gemini splits a session's transcript into timestamped chapters with titles/summaries, clickable to jump to that point in the transcript.
- **Audio Overview** (per-meeting mode): a kebab-menu action on an ended, summarized meeting — generates a two-host spoken discussion of *that meeting's* summary + open action items (§2.11 covers the subject-driven session-type mode).

### 2.5 Pre-meeting prep

- **Meeting-type classification** (`src/prep/meetingTypes.ts`): signal-based (title/description keywords, recurrence, attendee count) against a calendar event, defaulting to `generic` — manual override in the New Session modal's dropdown is the load-bearing path.
- **Type-specific workflows** (`src/prep/workflows/*.ts`), each a declarative list of tool sources fanned out and gated by `activeTools`:
  | Workflow | Sources |
  |---|---|
  | `standup` | Jira (blockers + recent activity), Confluence (sprint goal), previous standup's notes |
  | `sprint_planning` | Jira (backlog + carryover), Confluence (velocity), Bitbucket (recent + my PR activity) |
  | `sprint_review` | Jira, Confluence, Bitbucket, my PR activity, email, previous review's notes |
  | `retro` | Jira, Confluence, sentiment signal from the previous instance |
  | `one_on_one` | mem0, Jira, email, Teams, local DB-only open-action-items-by-owner |
  | `design_dev` | Confluence design docs, Jira related tickets, Bitbucket recent activity, MyRAG, local codebase, email, Teams, web search |
  | `generic` (fallback) | Jira + Confluence + personal RAG, plus Bitbucket only if the topic looks code-related, plus email/Teams |
- **Synthesis**: one Gemini call turns the gathered sources into a structured brief; runs fully async (never blocks starting the recording) and seeds the session's meeting-state rolling summary directly, so live suggestions and trigger classification pick it up for free.
- **"Just save" / "Run prep later"**: prep is never forced at creation — the New Session modal creates the session immediately (`skipPrep`); a "Run prep now"/"Retry prep" button in the Prep Brief tab triggers it later using the tools/meeting-type/calendar-event already stored on the row.
- **Calendar-driven prep**: `GET /api/calendar/upcoming` shows this week's not-yet-linked events with one-click "Prep this meeting" shortcuts (Google Calendar if configured, else the Outlook desktop COM fallback).
- **Anticipated Q&A**: pre-computed likely questions/answers for the upcoming meeting, surfaced live during it.

### 2.6 Calendar integration

- **Two independent providers**, tried in order — Google Calendar first (if configured), else Outlook desktop COM automation (`GetDefaultFolder(9)`, via a PowerShell script) as a fallback for on-premises/hybrid mailboxes Graph can't reach. Never merged/deduped between the two.
- **Automatic session creation**: a background poller (`CALENDAR_IMPORT_ENABLED`) imports this week's upcoming meetings as real sessions with a pre-run prep brief, `scheduledStartAt` set to auto-start recording at the meeting's start time, and `scheduledEndAt` to auto-stop it at the meeting's end. Deliberately skips: already-started/past events, solo blocks (no attendees), canceled meetings (checked via Outlook's `MeetingStatus`/Google's `event.status`, not by matching a locale-dependent "Canceled: " subject prefix). Dedup is by `calendar_event_id`, so reruns and manual creation from the same event never double up.
- **Calendar view**: a real day/week grid (`GET /api/calendar/week`) showing every event (including past/solo/canceled ones, visually distinguished), click-through to the linked session where one exists.
- **Meeting metadata carried onto the session**: location, organizer, attendee display names, and description are pulled from the calendar event and shown in the Prep Brief tab, independent of the prep brief's own success/failure.
- **Resuming a stopped session**: any ended `work`/`meeting` session can be manually resumed (clears `ended_at`, keeps all existing transcript/summary/etc. — new segments just keep appending) — added specifically because a mis-timed calendar auto-start/stop could otherwise strand a session permanently in "stopped."

### 2.7 "Implement with Claude Code"

For `code_change`-type action items: dispatches the `claude` CLI in the background (`claude --bg "<prompt>" --worktree --permission-mode acceptEdits --allowedTools "Write" "Edit" --disallowedTools "Bash(git commit:*)" "Bash(git push:*)"`) to make the actual code edit in an isolated, auto-created git worktree — **never** the real working directory.

- Commit and push are two separate, explicit, later gates (`POST .../approve` only commits; `POST .../push` is a distinct call, enabled only once status is `applied`) — read literally from the hard constraint this feature was built under: "no commit or push allowed unless approved."
- The commit/push block is enforced by Claude Code's own permission system (`--disallowedTools`), confirmed by direct testing — not a Speako-side check that could be bypassed.
- Progress is polled (`claude agents --json --all`, a simple `setTimeout` loop, 10s interval, 20-minute cap) until a terminal state; the resulting diff (captured via `git add -A && git diff --cached` in the worktree, since a bare `git diff` misses new untracked files) is stored in the DB and shown for review before approval.

### 2.8 Chat with AI (voice)

A live, full-duplex spoken conversation with Gemini (the Gemini Live API over its own WebSocket relay), created via New Session modal → "Chat with AI" or the sidebar header's mic icon. Persists a real `sessionKind: 'chat'` session + transcript (both sides' speech transcribed live) — same privacy posture as any recorded meeting, not ephemeral. Carries the modal's name/language/tools selections through when started that way; the mic-icon shortcut uses global defaults. Function-calling lets Gemini pull in Jira/Confluence/mem0/MyRAG/Bitbucket/local-codebase/past-meetings on its own judgment (`VOICE_TOOL_KEYS` — deliberately narrower than a meeting session's full tool set: no email/Teams/web search).

### 2.9 Practice mode

The same live-voice mechanism as Chat, but for rehearsing a real meeting — on stop, runs coaching-feedback analysis of the roleplay (a chat session is a Q&A log, not something to critique). Persisted as `sessionKind: 'practice'`, shown in its own sidebar tab.

### 2.10 Cross-session Q&A & Insights

An "Insights" modal, independent of any single open session:
- **Ask**: a typed question answered purely from RAG across your *entire* meeting corpus (no session excluded, unlike in-session live Q&A) — with history of past cross-session questions/answers.
- **Topics**: a frequency chart of topics discussed across all sessions, with drill-down.

### 2.11 Audio Overview

A generated two-host ("HostA"/"HostB") spoken discussion — a script written by Gemini, then synthesized to speech via Gemini's TTS model (`gemini-2.5-flash-preview-tts`, two-speaker `multiSpeakerVoiceConfig`) and wrapped in a WAV file. Two distinct entry points:

- **Per-meeting recap**: a kebab-menu action on an already-ended, summarized meeting session — grounds the discussion in that meeting's own summary + open action items. Regenerating replaces the previous audio/script for that session (old file deleted).
- **Subject-driven, as its own session type** (`sessionKind: 'audioOverview'`): created via New Session modal → "Audio Overview" — you describe any subject, pick which tools this overview may draw on, and Speako gathers grounding material via the *same tool-fanout machinery the prep workflows use* (`gatherToolSources`/`trySource`, `src/prep/workflows/types.ts`): Jira, Confluence, Bitbucket, mem0, MyRAG, local codebase, email, Teams, web search — plus past-meeting RAG — each gated by the session's own `activeTools`. The session is created and marked "ended" immediately (there's no recording phase); it appears in the sidebar's "Audio Overview" tab showing "generating…" then "ready," and opening it shows a dedicated "Overview" tab (script + player) — every other tab (transcript, summary, etc.) is hidden since none apply.

Both modes persist to the same `audio_overviews` table (`session_id`, `subject_text`, `script_text`, `audio_path`) — deleting a session cleans up its audio file, not just the DB row.

### 2.12 Tool integrations

| Tool | Mechanism |
|---|---|
| **Jira** | `mcp-atlassian` MCP server (spawned locally via `uvx`) — read: `jira_search`/`jira_get_issue` (issue keys regex-extracted and looked up directly, since full-text search doesn't match on keys); write: `jira_create_issue`/`jira_update_issue` |
| **Confluence** | Same MCP server — read: `confluence_search`; write: `confluence_create_page`/`confluence_update_page` |
| **Bitbucket** | Direct REST API (Server/Data Center — self-hosted, not Bitbucket Cloud, a different API entirely; no MCP package exists for it). No working server-wide search on this instance, so scoped to specific configured repos: recent-commit keyword overlap + direct file lookup |
| **Bitbucket PR reviews** | Same REST integration, repo-agnostic (`dashboard/pull-requests?role=...`) — "PRs assigned to me," "my open PRs' review status," heuristic `@mention` detection in comments on PRs you're already involved in |
| **mem0** | MCP over HTTP transport — long-term personal-fact memory, written to (capped at 3 facts/summary) after a meeting and read from during one-on-one prep |
| **MyRAG** | MCP over HTTP transport — one-off external reference material (linked specs, competitor docs), distinct from Speako's own local transcript/codebase RAG |
| **Local codebase** | Same chunk→embed→store→cosine-search pattern as transcript RAG, pointed at locally checked-out repos (`CODEBASE_LOCAL_PATHS`) — code never leaves the machine except text sent to Gemini for embedding |
| **Email / Teams** | Microsoft Graph (device-code OAuth, `Chat.Read`/`Mail.Read` — user-consentable scopes, no tenant-admin approval needed) as the primary path; Outlook desktop COM automation (PowerShell, manual-trigger only) as a fallback for mailboxes Graph can't reach (on-prem/hybrid Exchange, B2B guest accounts) |
| **Web search** | Gemini's built-in Google Search grounding tool — no separate search API/key |

### 2.13 Session management & settings

- Sidebar: start/stop/rename/delete, per-kind history tabs, prep-status badges, a resizable Suggestions/Triggers panel.
- Per-session "Tools for this session" and "heavy features for this session" popovers.
- **Cost tracking**: every Gemini call's real token usage (`gemini_usage` table) is logged and attributed per feature, so cost-optimization changes can be verified against real numbers.
- **Live logs viewer**: an in-app panel (level filter, autoscroll) fed by a console-patching in-memory ring buffer + WebSocket fan-out — no logging library, every existing `console.*` call site works unmodified.
- Settings modal: every optional integration's credentials/URLs, feature toggles, and model overrides.

---

## 3. Architecture

### 3.1 High-level shape

A single Node.js process (`src/index.ts`) that:

1. Spawns **SoX** as a subprocess for raw PCM mic (+ optional system-audio) capture.
2. Streams that audio to **Google Cloud Speech-to-Text v2** (`chirp_3`) over a persistent gRPC stream.
3. Persists everything to a local **SQLite** database (`better-sqlite3`, WAL mode) — no separate DB server.
4. Serves a small **Express** app + **WebSocket** server (`ws`) that a single static HTML page (vanilla JS, no framework/build step) connects to — the browser has no direct access to the audio stream or any credentials; all capture/processing happens server-side.
5. Calls **Gemini** (`@google/genai`) for every reasoning task: classification, suggestions, summarization, fact-checking, embeddings, meeting-state updates, TTS (Audio Overview), Google-Search-grounded web fallback.
6. Calls **MCP (Model Context Protocol)** servers, spawned as local subprocesses or over HTTP, for Jira/Confluence/mem0/MyRAG.
7. Calls Bitbucket Server's REST API and Microsoft Graph directly; shells out to PowerShell for Outlook desktop COM automation (mail + calendar fallback) and for `claude` CLI dispatch (Implement with Claude Code).

No build step is required for day-to-day development — `npm run dev` runs `ts-node` directly. `npm run build` compiles to `dist/` for `npm start`.

### 3.2 Directory map

```
src/
  index.ts                CLI entrypoint
  session.ts              wires every live pipeline stage together for the active recording
  config.ts                all .env-backed settings + feature toggles
  languages.ts             UI-offered language codes
  router.ts                shared "does this look code-related" heuristic
  settingsStore.ts         DB-backed settings overrides (Settings modal)
  types.ts                 core domain types (TranscriptSegment, etc.)

  audio-capture/           SoX subprocess capture, WAV recording/header, waveform downsampling
  transcription/           Speech-to-Text v2 streaming client + reconnect/restart logic
  diarization/             on-demand post-session speaker identification (BatchRecognize)
  sentiment/               live per-segment sentiment scoring (Cloud Natural Language)
  triggers/                live trigger classification + detection state machine
  suggestions/             category-specific proactive-suggestion generation
  rag/                     transcript chunk→embed→store→cosine-search (personal corpus)
  state/                   meeting-state rolling summary + open-items layer
  qa/                      in-session live Q&A + cross-session ("ask all my meetings") Q&A
  factcheck/               multi-source fact-check pipeline + web fallback
  summarization/           summary/action-item extraction, chapters, action-item drafts,
                           Audio Overview script+TTS generation and its context gathering
  coaching/                post-session/practice coaching-feedback analysis
  insights/                topic frequency + relationship trend analytics
  codebase/                local repo walking, chunking, indexing, search (for design/dev prep)
  communications/          external message (email/Teams) chunking, indexing, search
  calendar/                calendar auto-import (session creation, scheduling)
  prep/                    pre-meeting prep: meeting-type classification, per-type workflows,
                           tool catalog, brief synthesis, anticipated Q&A
  voice/                   Gemini Live session (Chat/Practice) + its system instructions
  tools/                   ToolKey/activeTools + activeFeatures gating definitions
  integrations/            one file per external system: Jira/Confluence (MCP), Bitbucket
                           (REST), mem0/MyRAG (MCP-HTTP), Google Calendar, Microsoft Graph,
                           Outlook desktop (COM via PowerShell), Claude Code CLI dispatch
  mcp/                     shared generic MCP client (stdio or HTTP transport)
  gemini/                  Gemini client construction, usage logging, context caching
  storage/                 SQLite schema (db.ts) + one repository module per table
  logging/                 console-patching in-memory log buffer + subscriber fan-out
  interface/               Express routes, WebSocket broadcast, and the static frontend
    server.ts              every HTTP route + WS message type
    public/index.html       the entire frontend: HTML + CSS + vanilla JS, one file
```

### 3.3 Data flow — live session

```
Mic/system audio (SoX subprocess, raw PCM)
        │
        ├─▶ Google Speech-to-Text v2 (streaming) ──▶ transcript segments ──▶ SQLite + WebSocket → browser
        ├─▶ WAV file (local recording — diarization source, never auto-uploaded)
        └─▶ downsampled envelope ──▶ WebSocket → browser (waveform canvas)

Each finalized transcript segment
        ├─▶ Cloud Natural Language sentiment ──▶ SQLite + WebSocket (tone coloring, tone-shift input)
        ├─▶ Trigger classification (Gemini) + tone-shift/unanswered-question/code-reference logic
        │        ├─▶ Suggestion generation (Gemini + RAG/codebase + meeting state) ──▶ Suggestions panel
        │        └─▶ Fact-check (factual_claim only): Bitbucket*/Jira/Confluence → web fallback → verdict
        └─▶ every N segments: meeting-state update (Gemini) — rolling summary + open items

* Bitbucket only queried when the claim looks code-related.
```

### 3.4 Data flow — on-demand

```
POST /api/sessions/:id/diarize          upload WAV → GCS → BatchRecognize (diarization) → replace segments
POST /api/sessions/:id/summarize        Gemini over full transcript → summary + action items
POST /api/sessions/:id/coach            Gemini over full transcript → coaching feedback
POST /api/sessions/:id/chapters         Gemini over full transcript → timestamped chapters
POST /api/audio-overviews               {sessionId} or {subject,activeTools} → tool-fanout/RAG
                                         context gather → Gemini script → Gemini TTS → WAV
POST /api/session/prepare               calendar/meeting-type → per-type workflow tool fanout
                                         → Gemini brief synthesis → seeds meeting-state
POST /api/action-items/:id/jira|confluence   AI-drafted fields (Gemini) → user review →
                                              real MCP write (jira_create_issue, etc.)
POST /api/action-items/:id/implement    dispatch `claude` CLI in an isolated worktree
POST /api/triggers/:id/recheck          re-run the fact-check pipeline against edited claim text
GET  /api/insights/ask                  RAG across the entire corpus (no session excluded) → Gemini
```

Every async, potentially-slow POST here follows the same **started/broadcast** pattern: the route responds `{ started: true }` immediately, the work runs fire-and-forget, and progress/result/failure are pushed to the browser over the existing shared WebSocket (`X-generating`/`X-ready`/`X-failed` message types) — never a long-held HTTP request.

### 3.5 Storage layer

SQLite via `better-sqlite3`, one file (`data/speako.db`), no migrations framework — new columns/tables are added via `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` blocks run at every startup, with one-off data backfills where needed (e.g. inferring `session_kind = 'practice'` for pre-existing rows from a name prefix).

| Table | Purpose |
|---|---|
| `sessions` | One row per session: id, start/end time, language(s), name, `sessionType`/`sessionKind`, meeting type, calendar link, prep status, active tools/features, schedule, calendar metadata |
| `transcript_segments` | Finalized transcript lines (speaker, time range, text) |
| `interim_segments` | Latest non-final result per (session, speaker) — crash-recovery only, cleared on a clean stop |
| `summaries` / `action_items` | Generated meeting summary; extracted/manual action items (owner, due date, status, confidence, type, external write reference) |
| `code_change_requests` | "Implement with Claude Code" job state (running/ready/applied/pushed/discarded/failed) + captured diff |
| `sentiment_scores` | Per-segment sentiment score/magnitude |
| `triggers` | Every fired trigger (category, confidence, reason, claim text, time range) |
| `suggestions` | Generated suggestions, linked to their trigger, with accept/dismiss state |
| `fact_checks` | Every fact-check attempt (claim, sources queried, verdict, surfaced flag) |
| `corpus_chunks` / `code_chunks` | RAG corpus: chunked transcript text / local-codebase text + embeddings |
| `live_queries` / `cross_session_queries` | In-session live Q&A history; cross-session "ask all my meetings" history |
| `meeting_state` | One row per session: rolling summary + open-items JSON + update progress marker |
| `prep_briefs` | Synthesized pre-meeting brief + which sources were queried |
| `coaching_feedback` | Post-session/practice coaching analysis |
| `meeting_chapters` | Timestamped chapter list per session |
| `audio_overviews` | Generated audio overviews — nullable `session_id` (legacy subject-driven rows), `subject_text`, `script_text`, `audio_path` |
| `external_messages` / `external_message_chunks` | Synced email/Teams messages + their RAG chunks |
| `gemini_usage` | Per-feature token-usage log for cost tracking |
| `settings` | DB-backed overrides of `.env` config (Settings modal) |

Deleting a session cascades through every one of the above in FK-safe order (children before parents), plus removes its recorded WAV and any audio-overview file from disk — not just DB rows.

### 3.6 AI / model layer

All reasoning goes through **Gemini** (`@google/genai`), tiered by task cost:
- `config.geminiModel` (`gemini-flash-latest` alias, avoiding pinned-model deprecation surprises) — creative/reasoning tasks: summarization, suggestions, fact-check verdicts, prep synthesis, Audio Overview scripts.
- `config.geminiFastModel` (with `thinkingBudget: 1`) — cheap, mechanical extraction: trigger classification, action-item-draft field suggestions.
- `config.geminiTtsModel` (`gemini-2.5-flash-preview-tts`) — Audio Overview speech synthesis, `multiSpeakerVoiceConfig` for the two-host format.
- `gemini-embedding-001` — RAG embeddings (transcript corpus, local codebase corpus, external-message corpus).

Every call's real `usageMetadata` is logged to `gemini_usage`, tagged by feature (`logGeminiUsage`) — fire-and-forget, fail-soft, never blocks the caller.

### 3.7 Real-time layer

One shared WebSocket (`InterfaceServer`'s `broadcast()`) carries every live-update type: transcript segments, waveform envelopes, sentiment/trigger/suggestion/fact-check results, session lifecycle events (start/stop/pause/resume/rename/delete/schedule changes), prep status, and every on-demand feature's generating/ready/failed states. The frontend's single `ws.onmessage` handler branches on `msg.type`, applying updates only when relevant to what's currently open (matching `msg.sessionId === activeSessionId` where applicable) so a background tab doesn't do unnecessary work.

### 3.8 External integration patterns

Three distinct patterns, chosen per what each external system actually offers:
- **MCP servers** (Jira/Confluence via `mcp-atlassian`, spawned locally per call via `uvx`; mem0/MyRAG over HTTP transport) — used wherever a maintained MCP server exists and covers what's needed.
- **Direct REST** (Bitbucket Server, Microsoft Graph) — used where no MCP package exists (Bitbucket) or where Graph's own REST API is the natural fit.
- **Shelling out to an external tool/process** (SoX for audio capture, PowerShell for Outlook desktop COM automation — mail, calendar, since "New Outlook" has no COM support at all — and for the `claude` CLI's background dispatch) — used deliberately instead of native Node bindings, to avoid node-gyp/native-compilation dependencies that could break across Node/Electron version bumps.

---

## 4. Known limitations (by design)

- Live speaker separation is channel-based (mic vs. system audio), not real diarization — true per-speaker labels are only available as an on-demand post-meeting step, and even then have no minimum-quality guarantee (pauses/background noise can be misattributed as separate speakers).
- No handling for simultaneous overlapping speech within a single channel.
- Interim (non-final) transcript results are shown live and recoverable after a crash, but not part of the permanent transcript unless finalized.
- Bitbucket fact-check/search is scoped to specifically-listed repos and commit-message/file-path matching, not true full-text search (this Bitbucket Server instance has no working search feature at all).
- No true "mentioned me in a comment" search across all of Bitbucket — only comments on PRs you're already involved in are scanned.
- Calendar auto-import only runs while Speako is actually open at the time (a poller, not an OS-level scheduler).
- Single-session-at-a-time recording — not designed for concurrent recordings.
- Outlook desktop COM automation only works with classic desktop Outlook, not the newer "New Outlook" client, and its email sync stays manual-trigger-only (never polled) since Outlook's security prompt could stall an unattended run — the calendar side of the same mechanism is polled anyway, a deliberate, explicitly-accepted exception.

See [NOTES.md](./NOTES.md) for the full build log behind every one of these decisions, plus every empirically-confirmed API quirk (model deprecations, client-library bugs, locale-dependent serialization gotchas, and more) encountered while building this.

---

## 5. Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js, TypeScript (CommonJS, `ts-node` for dev) |
| Audio capture | SoX (external binary, spawned as a subprocess) |
| Speech-to-text | Google Cloud Speech-to-Text v2 (`@google-cloud/speech`), `chirp_3` model |
| Diarization | Same API, `BatchRecognize` with `diarizationConfig` |
| Audio storage | Google Cloud Storage (`@google-cloud/storage`), diarization uploads only |
| Sentiment | Google Cloud Natural Language (`@google-cloud/language`) |
| LLM / reasoning / TTS / embeddings | Gemini via `@google/genai` |
| Web search fallback | Gemini's built-in Google Search grounding tool |
| Jira / Confluence / mem0 / MyRAG | Model Context Protocol (`@modelcontextprotocol/sdk`), stdio (`mcp-atlassian` via `uvx`) or HTTP transport |
| Bitbucket | Direct REST API (Bitbucket Server/Data Center, Basic auth) |
| Email / Teams | Microsoft Graph (`googleapis`-style OAuth via `@azure/msal-node`, device-code flow) + Outlook desktop COM (PowerShell) fallback |
| Calendar | Google Calendar API (`googleapis`) + Outlook desktop COM (PowerShell) fallback |
| Code dispatch | `claude` CLI, spawned in an isolated git worktree |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Web server | Express + `ws` (WebSocket) |
| Frontend | Single static HTML file, vanilla JS, no framework/build step |

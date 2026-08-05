# Speako 1.0 — Documentation

A personal, local-first AI meeting assistant. It listens to a live meeting (microphone + optionally system/loopback audio), transcribes it in real time with speaker separation, and layers a set of reasoning features on top: live sentiment, proactive trigger detection, fact-checking against your own tools (Bitbucket/Jira/Confluence/web), in-meeting Q&A, and post-meeting summarization. Everything runs on your own machine against your own cloud accounts — there is no Speako backend service; "the server" is a Node process you run locally.

---

## 1. What it does

### Live, while recording
- **Real-time transcription** with basic speaker separation (you vs. others, via separate mic/system audio channels — not ML diarization).
- **Live sentiment scoring** per transcript segment (tone coloring in the UI).
- **Trigger detection**: five categories of "worth flagging" moments — factual claims, decision points, vague commitments, tone shifts, and unanswered questions — each with confidence thresholds, per-category cooldowns, and an overall rate limit so it doesn't spam.
- **Proactive suggestions**: for each trigger, a one-line grounded suggestion (a clarifying question, a fact-check verdict, etc.), citing your own past meetings via RAG where relevant.
- **Fact-checking**: factual claims are automatically checked against Bitbucket (code/commits), Jira (tickets), Confluence (docs), and — if none of those have anything relevant — a live web search. Only contradictions ("conflict") surface as a card; matches/insufficient results are logged quietly. Every check's status is visible inline next to the trigger that caused it, with an edit-and-recheck control for fixing a transcription typo.
- **Meeting-state tracking**: a rolling summary and an open-items registry (unresolved questions/commitments/flagged claims) maintained incrementally throughout the meeting, used to avoid duplicate/stale suggestions and to ground fact-checking and Q&A in what's already been discussed.
- **Live audio waveform**: a small scrolling oscillogram next to the session title, confirming audio capture is actually active.
- **Live Q&A**: ask a typed question mid-meeting; answered using your own past meetings (RAG), the live transcript so far, the meeting-state summary, and Bitbucket/Jira/Confluence/web where relevant, with source attribution.

### On-demand, after recording stops
- **Speaker identification (diarization)**: uploads the session's recording to Google Cloud Storage and re-runs it through Speech-to-Text with true diarization, replacing the live "You"/"Others" labels with real per-speaker labels.
- **Summary generation**: overview, key decisions, discussion topics, next steps, plus extracted action items (owner/due date/confidence) via Gemini.
- **Export**: save the transcript as a plain text file.

### Session management
- Start/stop/rename/delete sessions from a sidebar list; each session tracks recording state, language, diarization status, and whether a summary exists.
- A resizable Suggestions/Triggers panel alongside the live transcript.

---

## 2. Architecture

Speako is a single Node.js process (`src/index.ts`) that:
1. Spawns **SoX** as a subprocess to capture raw PCM audio from the mic (and optionally a second "system audio" input device, merged sample-aligned via SoX's `-M` mode).
2. Streams that audio to **Google Cloud Speech-to-Text v2** (`chirp_3` model) over a persistent gRPC stream, restarting periodically to avoid undocumented server-side limits.
3. Persists everything to a local **SQLite** database (`better-sqlite3`).
4. Serves a small **Express** app + **WebSocket** server (`ws`) that a plain HTML/CSS/vanilla-JS single-page UI connects to — the browser is a thin display client with no direct access to the audio stream; all capture and processing happens server-side.
5. Calls out to **Gemini** (`@google/genai`) for every reasoning task (classification, suggestions, summarization, fact-checking, embeddings, meeting-state updates, web-grounded fact-checking via Gemini's Google Search grounding tool).
6. Calls out to **MCP (Model Context Protocol)** servers, spawned as local subprocesses, for Jira/Confluence search (`mcp-atlassian` via `uvx`).
7. Calls Bitbucket Server's REST API directly (no MCP server exists for it) and Google Cloud Storage/Natural Language APIs for diarization audio upload and text sentiment.

There is no build step required for day-to-day development — `npm run dev` runs `ts-node` directly against `src/index.ts`. `npm run build` compiles to `dist/` for `npm start`.

### Data flow (live session)

```
Mic/system audio (SoX subprocess, raw PCM)
        │
        ├─▶ Google Speech-to-Text v2 (streaming) ──▶ transcript segments ──▶ SQLite + WebSocket → browser
        ├─▶ WAV file (local recording, for later diarization)
        └─▶ downsampled envelope ──▶ WebSocket → browser (waveform canvas)

Each finalized transcript segment
        ├─▶ Cloud Natural Language sentiment ──▶ SQLite + WebSocket (tone coloring, tone-shift trigger input)
        ├─▶ Trigger classification (Gemini) + tone-shift/unanswered-question logic ──▶ trigger fires
        │        ├─▶ Suggestion generation (Gemini + RAG + meeting state) ──▶ Suggestions panel
        │        └─▶ Fact-check (factual_claim only): Bitbucket/Jira/Confluence → web fallback → verdict
        └─▶ every N segments: meeting-state update (Gemini) — rolling summary + open items
```

### Data flow (on-demand)

```
POST /api/sessions/:id/diarize      → upload WAV to GCS → BatchRecognize w/ diarization → replace segments
POST /api/sessions/:id/summarize    → Gemini over full transcript → summary + action items
POST /api/sessions/:id/ask          → RAG + meeting state + Bitbucket/Jira/Confluence/web + full transcript → Gemini → answer
POST /api/triggers/:id/recheck      → re-run fact-check pipeline against edited claim text
```

---

## 3. Feature reference

### 3.1 Transcription & speaker separation
- Google Cloud Speech-to-Text v2, `chirp_3` model, streaming recognition via the internal `_streamingRecognize()` method (the public `streamingRecognize()` wrapper is broken for v2 — never sets the required `recognizer` field).
- Speaker separation is **channel-based**, not ML diarization: mic audio → "You", system/loopback audio → "Others". This requires a second audio input capturing system/tab audio (a virtual audio cable like VB-CABLE on Windows, since there's no native loopback device).
- Supported languages (chirp_3, streaming-capable): English (US/UK), French (France/Quebec), Arabic (Morocco — Preview quality, not GA). `SPEECH_LANGUAGE_CODES=auto` lets chirp_3 auto-detect the dominant language instead of pinning one.
- Domain-vocabulary biasing via a versioned phrase-hints list (`config/phrase-hints.json`) fed into speech adaptation.
- Streams restart every `STREAM_RESTART_SECONDS` (default 240s) to avoid instability on long sessions; segment timestamps are stitched across restarts.

### 3.2 Live sentiment
- Google Cloud Natural Language `analyzeSentiment` on each finalized segment's text (not audio/vocal tone — a text-only signal).
- Feeds the tone-shift trigger category (a rolling-average comparison, not an LLM call).

### 3.3 Trigger detection (five categories)
| Category | Detection method |
|---|---|
| `factual_claim` | Gemini classification of the current transcript window |
| `decision_point` | Gemini classification |
| `vagueness` | Gemini classification (commitment without owner/deadline) |
| `tone_shift` | Rolling sentiment-average delta (no LLM call) |
| `unanswered_question` | Timer — a question with no follow-up segment within a configurable window |

Each category has its own confidence threshold, a per-category cooldown, and a shared overall rate limit per minute — tunable via `.env`. The Stage-1 classifier (`src/triggers/classify.ts`) deliberately only sees a small rolling window, not the whole meeting — it's a fast, cheap, stateless filter by design.

### 3.4 Suggestions
- One Gemini call per fired trigger, with a category-specific instruction (e.g. "suggest one clarifying question"), grounded in:
  - RAG-retrieved excerpts from your own past sessions.
  - The current meeting's rolling summary + open-items registry (suppresses duplicate/already-resolved suggestions via an explicit `SKIP` instruction).
- `factual_claim` suggestions are suppressed outright if RAG retrieval finds nothing relevant (a citation-free guess isn't useful); other categories still fire without grounding.

### 3.5 RAG (personal corpus)
- Every stopped session's transcript is chunked and embedded (`gemini-embedding-001`) into a `corpus_chunks` table.
- Retrieval is brute-force cosine similarity in SQLite — no external vector DB, by design, at personal-meeting-history scale.
- Used by suggestion generation and live Q&A.

### 3.6 Fact-checking
- Only `factual_claim` triggers are checked.
- **Bitbucket Server** (self-hosted, direct REST + Basic auth — not Bitbucket Cloud, a different API entirely): this instance has no working server-wide code search (confirmed broken both via REST and the web UI), so it's scoped to specific `PROJECT_KEY/repo-slug` pairs and checks recent commit messages for keyword overlap, plus direct file-content lookup if a path is named in the claim. Only queried when the claim looks code-related (a keyword heuristic in `src/router.ts`).
- **Jira** and **Confluence**: queried via the `mcp-atlassian` MCP server (spawned locally via `uvx`), read-only tools only (`jira_search`, `jira_get_issue`, `confluence_search`) — write/mutate tools are never called. A claim naming a specific issue key (e.g. `ETICK-9634`) is looked up directly via `jira_get_issue` rather than relying on full-text search, which doesn't match on keys.
- **Web fallback**: if none of the above found anything relevant, falls back to Gemini's built-in Google Search grounding — no separate search API/key needed. Only triggers when the internal sources' judgment is genuinely `insufficient`, not merely "returned some content" (Confluence's search in particular always returns its closest results even for unrelated queries).
- The verdict (`match`/`conflict`/`insufficient`) cites only the specific source that actually supported it, not every source that was attempted.
- Only `conflict` verdicts surface as a UI card; every attempt (regardless of verdict) is visible as an inline status badge on its trigger, with a "Proof" section shown for verified (`match`) claims.
- **Edit-and-recheck**: the exact claim text a trigger fired on is editable inline (fixes transcription typos), and re-running the check re-invokes the same pipeline against the corrected text.

### 3.7 Meeting-state layer
- One row per session: a rolling summary (merged incrementally, not just appended) and an open-items registry (questions/commitments/flagged claims, each resolved simply by being omitted from the next update rather than tracked via separate diff logic).
- Updated every `MEETING_STATE_UPDATE_EVERY_SEGMENTS` (default 6) finalized segments, fire-and-forget — never blocks live transcription.
- Feeds suggestion suppression, fact-check context, and live Q&A context. Deliberately **not** fed into Stage-1 trigger classification, which stays intentionally stateless/window-scoped.

### 3.8 Live Q&A
- A typed question, answered using: RAG (past sessions), the current meeting's rolling summary + open items, the full live transcript so far, and Bitbucket/Jira/Confluence/web (same source logic as fact-checking).
- Answers include source attribution.

### 3.9 Diarization (on-demand)
- Uploads the session's local WAV recording to a GCS bucket, runs Speech-to-Text v2's `BatchRecognize` with `diarizationConfig` (true ML diarization — only available via batch, not streaming, for any current model), replaces the live channel-based labels with real "Speaker N" labels.

### 3.10 Summarization (on-demand)
- One Gemini call over the full transcript → overview, key decisions, discussion topics, next steps.
- A second extraction pass produces action items (owner, due date, confidence: explicit vs. inferred).

### 3.11 Live audio waveform
- Purely cosmetic. The server downsamples each raw PCM audio chunk into a compact min/max envelope and broadcasts it over the existing WebSocket; the browser draws it as a scrolling oscillogram with client-side auto-gain (real mic levels only use a few percent of full scale, so a fixed-scale drawing would look nearly flat).
- Shown next to the session title, visible across all tabs, only while viewing the session that's actually recording.

---

## 4. Data model (SQLite)

| Table | Purpose |
|---|---|
| `sessions` | One row per meeting: id, start/end time, language(s), name, diarization timestamp |
| `transcript_segments` | Finalized transcript lines (speaker, time range, text) |
| `sentiment_scores` | Per-segment sentiment score/magnitude |
| `triggers` | Every fired trigger (category, confidence, reason, claim text, time range) |
| `suggestions` | Generated suggestions, linked to their trigger, with accept/dismiss state |
| `fact_checks` | Every fact-check attempt (claim, sources queried, verdict, ground truth, surfaced flag, accept/dismiss state) |
| `corpus_chunks` | RAG corpus: chunked transcript text + embeddings, per session |
| `live_queries` | Live Q&A history (question, answer, sources used) |
| `meeting_state` | One row per session: rolling summary + open-items JSON + update progress marker |
| `summaries` | Generated meeting summary (one per session) |
| `action_items` | Extracted action items (owner, due date, status, confidence) |

Deleting a session cascades through all of the above in FK-safe order (children before parents — e.g. `suggestions`/`fact_checks` before `triggers`, since both reference `triggers.id`).

---

## 5. Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js, TypeScript (CommonJS, `ts-node` for dev) |
| Audio capture | SoX (external binary, spawned as a subprocess) |
| Speech-to-text | Google Cloud Speech-to-Text v2 (`@google-cloud/speech`), `chirp_3` model |
| Diarization | Same API, `BatchRecognize` with `diarizationConfig` |
| Audio storage | Google Cloud Storage (`@google-cloud/storage`), for diarization uploads only |
| Sentiment | Google Cloud Natural Language (`@google-cloud/language`) |
| LLM / reasoning | Gemini via `@google/genai` (`gemini-flash-latest` alias — avoids pinned-model deprecation) |
| Embeddings | `gemini-embedding-001` |
| Web search fallback | Gemini's built-in Google Search grounding tool |
| Jira / Confluence | `mcp-atlassian` MCP server, spawned locally via `uvx`, `@modelcontextprotocol/sdk` client |
| Bitbucket | Direct REST API (Bitbucket Server/Data Center, Basic auth) |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Web server | Express + `ws` (WebSocket) |
| Frontend | Single static HTML file, vanilla JS, no framework/build step, native `<canvas>` for the waveform |

---

## 6. Configuration

All configuration is via `.env` (see `.env.example` for the full annotated list). Every optional feature is independently toggleable and degrades gracefully when unconfigured — the app runs with just the required GCP transcription setup and adds capability as more is configured:

- **Required**: `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, mic device name.
- **Optional, unlocks features when set**: `GEMINI_API_KEY` (sentiment/triggers/suggestions/summarization/fact-check/Q&A/meeting-state — most of the reasoning layer depends on this one key), `GCS_BUCKET` (diarization), `BITBUCKET_SERVER_*` / `JIRA_*` / `CONFLUENCE_*` (fact-check/Q&A sources).
- **Toggles** (all default to their documented behavior, settable to `false`): `SENTIMENT_ENABLED`, `TRIGGER_DETECTION_ENABLED`, `RAG_ENABLED`, `LIVE_QA_ENABLED`, `MEETING_STATE_ENABLED`, `WAVEFORM_ENABLED`.
- **Tuning**: trigger confidence/cooldown/rate-limit, RAG top-K/similarity threshold, meeting-state update cadence, stream restart interval.

---

## 7. Known limitations (by design)

- Speaker separation is channel-based (mic vs. system audio), not real diarization, during live recording — true per-speaker diarization is only available as an on-demand post-meeting step.
- No handling for simultaneous overlapping speech within a single channel (e.g. two remote participants talking over each other).
- Interim (non-final) transcript results are shown live but not persisted.
- Bitbucket fact-checking is scoped to specifically-listed repos and keyword/commit-message matching, not true full-text code search (the target Bitbucket Server instance has no working search feature at all, confirmed both via REST and its own web UI).
- No automatic retry/backoff tuning for a crash-looping Speech API connection.
- Single-session-at-a-time recording (one `currentSession` in-process) — not designed for concurrent recordings.

---

## 8. Project history

Built incrementally across four numbered phases plus an ongoing "Improvements" track:
1. **Phase 1** — live capture, streaming transcription, channel-based speaker separation.
2. **Phase 2** — SQLite storage, session management UI, on-demand diarization + summarization.
3. **Phase 3** — sentiment, trigger detection, personal RAG corpus, proactive suggestions.
4. **Phase 4** — multi-source fact-checking (Bitbucket/Jira/Confluence) and live Q&A, via MCP servers where available.
5. **Improvements** (ongoing) — persistent meeting-state layer, web fact-check fallback, edit-and-recheck, live audio waveform. (A voice/vocal-emotion analysis feature via a third-party vendor was scaffolded and later removed at the user's request — see `NOTES.md` if resurrecting it.)

See `NOTES.md` for the detailed build log: gotchas discovered, API quirks confirmed empirically, and design decisions with their rationale. See `README.md` for setup instructions.

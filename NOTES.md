# Known Limitations & Empirical Findings

## Phase 3: speech adaptation, sentiment, triggers, RAG, suggestions

Built incrementally (one piece verified live before the next), per an explicit
decision to deviate from the spec's literal build-everything-then-test order
given how much this phase touches. Also deviated from the spec on two points,
both consistent with earlier phases' decisions: (1) vector store is brute-force
cosine similarity over embeddings stored as JSON in SQLite, not Qdrant/pgvector
— no separate DB server needed at personal scale; (2) Gemini is used for
everything (classification, embeddings, reasoning) instead of Claude/GPT-4o,
since a working Gemini key already existed from Phase 2.

- **Speech adaptation confirmed working on chirp_3 in streaming mode** — the
  spec flagged this as unverified across Chirp versions. Empirically confirmed
  via an isolated test: `adaptation.phraseSets[].inlinePhraseSet.phrases[]` is
  accepted with no error, and the response metadata's `prompt` field literally
  showed the phrase list injected into chirp_3's internal LLM prompt
  ("has a high chance of including: {Keycloak, Qdrant, PIPEDA}") — further
  confirmation that chirp_3 is LLM-based under the hood, consistent with the
  diarization prompt leakage noted in the Phase 1/2 section below.
- **Gemini embedding model**: `gemini-embedding-001` (3072-dimensional
  vectors) confirmed working via `ai.models.embedContent({model, contents})`
  → `{embeddings: [{values: number[]}]}`. Verified the model list for this
  API key first (`GET /v1beta/models`) rather than assuming a name from
  training data, given the `gemini-2.5-flash` deprecation surprise from
  Phase 2 — good thing, since several plausible-looking model names in
  search results turned out to not exist for this key.
- **Trigger classifier is genuinely precise, not just prompted to sound
  precise** — verified with 4 isolated test sentences (one per category plus
  a neutral control): correctly flagged a specific metric+date as a factual
  claim, "let's go with X instead of Y" as a decision point, an ownerless
  vague commitment as vagueness, and correctly returned all-false on casual
  small talk ("the weather has been nice"). Also survived a real transient
  Gemini `503 UNAVAILABLE` ("high demand") during a live session without
  crashing — logged and skipped that segment's classification, exactly as
  designed.
- **RAG retrieval is correctly conservative, not just filtered by a
  threshold post-hoc** — verified with a claim that contradicted something
  in the corpus: the top-2 retrieved chunks by similarity didn't happen to
  contain the specific fact needed to judge conflict, and the model correctly
  output `SKIP` rather than guessing, per the explicit prompt instruction.
  A claim that clearly matched a retrieved chunk correctly generated a
  suggestion with an accurate citation. This is the "suppress rather than
  force a low-quality suggestion" behavior from spec §7.1 point 4, confirmed
  working in both directions (suppress on ambiguous evidence, generate on
  clear evidence) — not just confirmed as "empty result when threshold not
  met" (that part's trivial; the LLM step is where it could plausibly
  fabricate a citation despite thin evidence, and it didn't).
- **Real bug found and fixed**: RAG indexing (triggered on session stop)
  took a snapshot of segments at `stop()` time, but Google's streaming API
  can deliver a trailing final result for already-buffered audio slightly
  *after* `stop()` returns (same pattern documented below for the
  stop→delete crash). That trailing segment gets correctly saved to the
  transcript (via the existing resilient insert path) but was missed by the
  indexing snapshot taken moments earlier, leaving it unsearchable via RAG.
  Fixed with a 3-second delay before indexing — mirrors how this same class
  of race is already handled elsewhere in the app, rather than a new pattern.
- **Multi-provider precedent**: sentiment/triggers/RAG all run *automatically*
  during recording (unlike diarization/summarization, which are on-demand)
  because each only processes text already stored/shown live, and the whole
  point is that they need to run live to be useful — an "analyze triggers
  after the fact" button wouldn't serve the live-suggestion goal. Each still
  has its own `.env` toggle (`SENTIMENT_ENABLED`, `TRIGGER_DETECTION_ENABLED`,
  `RAG_ENABLED`) for anyone who wants to opt out of specific pieces.
- **Not yet empirically measured** (would need real multi-meeting usage over
  time, not achievable in a single build/test session): trigger
  precision/recall in practice, sentiment false-positive rate on blunt/
  technical communication styles, and which trigger categories prove most
  useful. The `suggestions` table's `user_action` (accepted/dismissed/ignored)
  is designed to be the feedback signal for this — worth revisiting after
  a few weeks of real use, per spec §11's own deliverables list.

## Phase 2: summarization & action items — Gemini API gotchas found

Built on-demand meeting summarization + action-item extraction (`src/summarization/summarize.ts`,
Gemini API via `@google/genai`). Same on-demand principle as diarization — nothing sent to Gemini
until the user clicks "Generate summary". Real gotchas hit while building this:

- **`gemini-2.5-flash` (the model this account's key defaults to, and the
  model most current documentation/tutorials reference) returned
  `404: This model ... is no longer available to new users`** despite the
  model still existing in the `/models` list. Google is evidently deprecating
  specific model names for new API keys quickly. **Fix**: use the
  `gemini-flash-latest` alias instead of a pinned version — it resolves to
  whatever's currently recommended, avoiding this exact surprise recurring.
  If pinning a specific version for reproducibility matters more than staying
  current, query `GET /v1beta/models?key=...` first to confirm it's actually
  usable by the key in question — don't trust a model name from docs/memory.
- **`@google/genai` is ESM-only** (`"type": "module"` in its package.json),
  which breaks a static `import` from this project's CommonJS files under
  `moduleResolution: "node16"` (the fix applied earlier for the deprecated
  `node10` warning) — TypeScript correctly refuses to statically import an
  ESM-flagged export from a CJS file, even though the package *does* ship a
  working `.cjs` build for `require()`. Worked around by `require()`-ing it
  directly and typing the client as `any` (see `summarize.ts`) rather than
  fighting the ESM/CJS boundary further.
- The real API shape is `ai.models.generateContent({model, contents, config:
  {responseMimeType, responseSchema}})` → `response.text` (a JSON string
  matching the schema). Some web search results surfaced a completely
  different, non-existent `ai.interactions.create()` shape — traced this to
  those results conflating an unrelated experimental "Interactions API"
  feature with the actual `generateContent` method. Cross-checked against the
  real `googleapis/js-genai` README before writing any code; worth repeating
  this lesson from Phase 1's streaming-API bugs — verify exact API shapes
  against primary sources (official README/source), not search-result
  summaries, before trusting them enough to write code against them.
- Action-item extraction is deliberately conservative by design (explicit
  prompt instruction to exclude vague statements) — verified against two real
  past sessions that were casual/ambiguous conversations, both correctly
  returned an empty action-items array rather than inventing anything, and
  against a synthetic transcript with two unambiguous commitments plus one
  vague "we should think about X sometime" aside, which correctly extracted
  only the two real commitments and dropped the vague one.

## Verified end-to-end against a real GCP project — two client-library gotchas found

Confirmed working with a real service account, real mic capture, and real
`chirp_3`/`long` streaming recognition. Along the way, two non-obvious bugs
surfaced in `@google-cloud/speech` (tested on 6.7.1 and 7.5.0 — both affected):

- **`speechClient.streamingRecognize()` (the public convenience method) is
  broken for v2**: it's a carried-over v1-era helper that never sets the
  `recognizer` field v2 requires, and silently wraps *every* `.write()` call
  as raw audio content instead of a full request. The result is an opaque
  `INVALID_ARGUMENT: Invalid resource field value in the request` /
  `RESOURCE_PROJECT_INVALID` error, no matter how correct the recognizer path,
  project, permissions, or model are (confirmed via isolated tests: unary
  `recognize()` with the identical config succeeded every time, proving the
  account/project/permissions were never the issue). **Fix**: call the
  underscore-prefixed `speechClient._streamingRecognize()` instead — the raw
  bidi stream matching the actual v2 proto, where you write
  `{ recognizer, streamingConfig }` as the first message and `{ audio }`
  after. See `src/transcription/streamManager.ts`'s `defaultCreateCall`.
- **25,600-byte hard cap per streamed audio message.** The server rejects
  anything larger with `INVALID_ARGUMENT: Audio chunk can be of a maximum of
  25600 bytes`. SoX's stdout chunks aren't guaranteed to respect this, so
  `StreamManager` now splits any chunk over the limit before writing.

If a future Google client library release fixes the public
`streamingRecognize()` wrapper, this workaround can be simplified back —
worth re-checking release notes before assuming it's still broken.

## Speaker separation is channel-based, not ML diarization

The original plan called for Google STT diarization (speaker labels for an
arbitrary number of speakers). Verified against current Google docs while
building this phase:

- **chirp_2 does not support diarization at all** (Google's docs explicitly
  say "Diarization: Not supported"), and is also regionally restricted to
  `us-central1` / `europe-west4` / `asia-southeast1` in Private GA.
- **chirp_3 supports diarization only in `BatchRecognize`, not in
  `StreamingRecognize`.** No current Google STT model does true diarization
  in real-time streaming mode.

Given that, this phase uses **multi-channel audio** instead: mic audio and
system/loopback audio are captured as two separate channels in one SoX
process (`sox -M ...`) and sent to Google with
`multiChannelMode: SEPARATE_RECOGNITION_PER_CHANNEL`. Channel 1 → "You",
channel 2 → "Others".

**Consequence**: this distinguishes *you* from *everyone else on the call*,
but does **not** distinguish between multiple remote participants speaking on
the same system-audio channel live — they'll all show up as "Others" during
the session. Real per-speaker labels are available after the fact — see below.

## On-demand post-session diarization (implemented)

Every session's raw audio is recorded locally to `data/audio/<sessionId>.wav`
regardless of anything else (cheap, stays local, no cloud involved). Speaker
identification itself is a **separate, explicit, on-demand action** —
`POST /api/sessions/:id/diarize` (the UI's "Identify speakers" button) —
never triggered automatically by starting or stopping a recording. This was
a deliberate choice: auto-uploading every session's audio to the cloud by
default has cost and privacy implications the user should opt into per
session, not have decided for them.

When triggered, it uploads the WAV to `GCS_BUCKET`, runs `BatchRecognize`
with `diarizationConfig` + `enableWordTimeOffsets` (chirp_3), groups
consecutive same-speaker words into turns, and — on success — **replaces**
that session's stored segments with the diarized ones ("Speaker 1", "Speaker
2", ... instead of "You"/"Others"), broadcasting the update live over the
WebSocket so an open browser tab updates without a refresh.

Two things confirmed empirically while building this:
- **`BatchRecognize` intermittently rejects a request immediately after the
  GCS upload it targets completes**, with an opaque
  `INVALID_ARGUMENT: Config contains unsupported fields`. Reproduced: the
  exact same request against the exact same already-uploaded file succeeded
  moments later. Transient, not a real config problem — `diarizeSession` now
  retries with backoff (see `batchRecognizeWithRetry` in
  `src/diarization/diarize.ts`).
- **chirp_3's diarization occasionally leaks its own internal LLM prompt
  text into the transcript** during quiet/ambiguous audio stretches, instead
  of cleanly emitting nothing. (Diarization is evidently LLM-based under the
  hood — the raw API response includes a literal prompt template instructing
  the model to label speakers `spk:1`/`spk:2`/etc. and output `[BACKGROUND]`
  for unclear audio; on at least one test run it echoed fragments of those
  instructions as if they were transcribed speech.) This is a model-level
  quirk, not something fixable from the client side — worth a sanity check /
  filter on suspiciously prompt-like transcript text if it turns out to be
  common in practice.
- Diarization also has no minimum-quality guarantee on speaker count: fed a
  single real speaker with pauses, it split them into 4-5 "speakers" — pauses
  and background noise get misattributed as distinct people. This is a
  property of the underlying model's diarization quality, not a bug in the
  turn-grouping code (verified the grouping logic against the raw word/label
  data directly).

## Session deletion vs. trailing transcription results (real crash, fixed)

Reproduced a genuine server crash while testing session deletion: Google's
streaming API can deliver a final result for already-buffered audio *after*
`StreamManager.stop()` is called (expected — it's flushing trailing speech,
not a bug in the streaming code). If the session's row was deleted from
SQLite in the meantime (e.g. `stop` immediately followed by a delete), that
trailing segment's `insertFinalSegment` call fails its foreign-key
constraint. Uncaught, that exception took down the **entire Node process**,
not just that one request. Fixed in `session.ts`'s segment handler with a
try/catch that logs and drops the trailing segment instead of crashing.
Verified fixed by reproducing the exact stop→delete sequence again — no crash.

**General lesson for this codebase**: any DB write triggered from an async
event callback (not a request handler) needs its own error handling — there's
no Express error middleware to catch it, and Node kills the process on an
uncaught exception by default.

## Stream restart interval is a resilience measure, not a hard requirement

Google's v1 streaming API had a well-documented ~305 second hard limit. The
v2 API's public docs do not document an equivalent hard cap. `STREAM_RESTART_SECONDS`
(default 240s) is implemented as a proactive resilience measure regardless —
long-lived network streams can still drop for other reasons — but the exact
safe interval hasn't been empirically verified against sustained real-world
use. Watch logs for `[transcription] error:` during long sessions and tune
the value if disconnects are more/less frequent than expected.

## Restart stitching caveats

- Absolute segment timestamps are reconstructed by tracking total audio
  duration written across all streams and offsetting each stream's own
  `resultEndOffset` by that running total. This has not been validated
  against a real multi-restart session yet — recommend a manual test with
  `STREAM_RESTART_SECONDS` set low (e.g. 30) to force several restarts and
  visually check the transcript for gaps, duplicated words, or timestamp
  jumps at the boundaries.
- Segment `startMs` is approximated as the previous final segment's `endMs`
  for that speaker — Google's v2 API only gives an end offset per result, not
  a start offset — so start times are not exact.

## Audio capture platform constraints

- Capture relies on the external `sox` binary (via `waveaudio` on Windows),
  not a native Node addon — simpler to install but adds an external
  dependency that must be on `PATH`.
- Windows has no built-in loopback recording device. Capturing system/tab
  audio requires either "Stereo Mix" (not present on all sound cards) or a
  virtual audio cable (e.g. VB-CABLE) with playback routed into it — this is
  manual per-machine setup, not something the app can configure automatically.
- **Confirmed on real Windows hardware**: SoX's `waveaudio` device names are
  the legacy MME names (truncated to 31 characters), not the friendly names
  Settings shows — e.g. actual Settings name vs. what SoX sees differed on
  the test machine. `scripts/list-audio-devices.ps1` (added during this
  verification) probes `winmm.dll` directly to get the exact names SoX needs.
- Confirmed SoX correctly captures/resamples straight to mono 16kHz even when
  the underlying device's native format is different (e.g. stereo 48kHz on
  the test machine) — no separate resampling step was needed.

## Not yet handled (by design, deferred)

- No automatic retry/backoff tuning for repeated rapid stream failures (a
  crash-looping Speech API connection will just keep restarting on a fixed
  interval and log errors).
- No handling for simultaneous overlapping speech within a single channel
  (e.g. two remote participants talking over each other) — this is a
  fundamental limitation of channel-based separation, not a bug to fix later
  without adding real diarization.
- Interim (non-final) results are shown live in the UI but not persisted —
  only finalized segments are written to SQLite.

## Phase 4: multi-source fact-check / live Q&A (Bitbucket Server + Jira + Confluence)

- **Bitbucket is Server/Data Center (self-hosted at `git.acceo.com`), not
  Bitbucket Cloud** — completely different REST API. There is no local MCP
  package for it that actually exists on the npm registry (an earlier
  assumed package name 404'd), so Bitbucket is queried via direct REST calls
  with HTTP Basic auth (`src/integrations/bitbucketServer.ts`), not MCP.
- **Server-wide code search does not work on this instance**: the code search
  REST endpoint (`POST /rest/search/latest/search`) returns HTTP 500
  regardless of request body shape, and the same search is confirmed broken
  in the Bitbucket web UI itself — so this is a server-side
  indexing/Elasticsearch issue, not something fixable from the client. Basic
  REST endpoints (auth, project/repo listing, file browse, raw file content,
  commit history) all work fine.
  - Given no free-text search, Bitbucket integration is scoped to specific
    repos via `BITBUCKET_SERVER_REPOS` (comma-separated `PROJECT_KEY/repo-slug`)
    and works by (a) scanning recent commit messages for keyword overlap with
    the claim/question, and (b) fetching a specific file's raw content if the
    query names a path directly (regex-extracted). This is a much weaker
    signal than real full-text search — expect frequent "insufficient"
    fact-check verdicts unless the claim closely echoes recent commit wording.
- **Jira and Confluence are queried via the `mcp-atlassian` MCP server**
  (spawned locally per-call via `uvx mcp-atlassian`), using its read-only
  `jira_search` (JQL, built here as `text ~ "<query>" ORDER BY updated DESC`)
  and `confluence_search` (accepts plain free text directly) tools. Never
  call any of this server's write/mutate tools (`jira_create_issue`,
  `jira_update_issue`, `confluence_create_page`, etc.) — fact-check/Q&A is
  read-only by design.
  - `mcp-atlassian` exposes both `jira_*` and `confluence_*` tools from the
    same process regardless of which env vars (Jira-only vs.
    Confluence-only) are passed — this doesn't matter functionally since each
    integration only calls its own tool, but don't assume env-var scoping
    filters the tool list.
  - The MCP tool result comes back as `content[0].text` containing a
    JSON-encoded string. **Gotcha**: when that JSON is a bare array (not
    wrapped in `{results: [...]}`), a naive `parsed.results ?? parsed.values
    ?? ...` fallback chain silently picks up `Array.prototype.values`
    (a real built-in iterator method — not `undefined`, so `??` doesn't skip
    past it) instead of falling through to the array itself, crashing with
    "pages.slice is not a function" downstream. Fix: check
    `Array.isArray(parsed)` *first*, before any property-name fallbacks.
  - Each spawned `uvx mcp-atlassian` subprocess has real startup latency
    (several seconds) — this project spawns one per source per call rather
    than pooling, and `McpServerClient` doesn't currently expose a `close()`,
    so any throwaway test script needs an explicit `process.exit(0)` or it
    hangs (the subprocess keeps the event loop alive).
- All three sources are queried unconditionally when configured, **except**
  Bitbucket, which is gated by `looksCodeRelated()` (`src/router.ts`) — Jira
  and Confluence cover too broad a range of topics (tickets, docs, meeting
  notes) to gate the same way; Bitbucket's commit/file search would just add
  noise for non-code claims.
- **Confirmed bug (found via real user testing, since fixed)**: a claim that
  names a specific issue key directly (e.g. "I think Jira ITIC-9652 is
  closed") silently returned zero Jira matches. `jira_search`'s `text ~
  "<sentence>"` JQL clause is full-text search over summary/description
  content — it does NOT match on issue keys, so quoting a key plus
  surrounding commentary reliably finds nothing even when the ticket exists.
  Fixed in `src/integrations/jiraMcp.ts`: `searchJira` now regex-extracts any
  `PROJECT-123`-style key from the query first and looks it up directly via
  `jira_get_issue`, falling back to the text-search clause for the rest. A
  nonexistent-key lookup's error text ("Issue X not found...") is itself
  surfaced as a match rather than discarded — that's useful signal for
  fact-checking (it can prove a claim's premise false), not noise.
  - Also note: `jira_get_issue`/`jira_search` results are flat objects
    (`{key, summary, status: {name, ...}, ...}`), not the nested
    `{fields: {summary, status: {name}}}` shape of Jira's raw REST API —
    don't assume the raw API's field nesting carries over to mcp-atlassian's
    normalized output.

## Phase 4 follow-up: web fact-check fallback + edit-and-recheck

- **Web fallback** (`src/factcheck/webFactCheck.ts`): for claims that
  Bitbucket/Jira/Confluence have nothing relevant on (general knowledge, not
  this team's code/tickets/docs), fact-checking now falls back to Gemini's
  built-in Google Search grounding (`tools: [{ googleSearch: {} }]`) instead
  of giving up. Confirmed empirically: this combines fine with structured
  JSON output (`responseSchema`) in the same call — search + verdict happen
  in one round trip, no separate search API/key needed. Citation domains
  come from `groundingMetadata.groundingChunks[].web.title` (the `.uri` is a
  Vertex AI redirect wrapper, not a real URL — only `.title` is
  human-readable, e.g. "nodejs.org").
- **Important gotcha this surfaced**: `confluence_search`'s plain-text mode
  (`siteSearch`, falling back to `text` search) **never returns empty** — a
  completely unrelated claim ("the Eiffel Tower is taller than the Statue of
  Liberty") still got back 5 Confluence pages about VPN status checks and bug
  ticket conventions. So `contextParts.length > 0` from internal sources is
  NOT a reliable signal that anything relevant was found, and gating the web
  fallback on it (the first implementation) meant the fallback almost never
  fired. Fixed in `factCheckClaim` (`src/factcheck/factcheck.ts`): internal
  sources are judged first regardless of how much (possibly irrelevant)
  context they returned; only a confident `match`/`conflict` short-circuits
  before trying the web. An `insufficient` internal verdict always falls
  through to the web fallback, and the final result prefers whichever
  verdict is actually confident.
- **Edit-and-recheck**: transcription errors (a misheard name, garbled
  ticket number) can make an otherwise-correct claim fact-check as a false
  conflict or false insufficient. The Triggers tab now shows the exact claim
  text a factual_claim trigger fired on (persisted as `triggers.segment_text`
  — added via migration, wasn't stored before this) with an inline Edit
  control; saving posts to `POST /api/triggers/:id/recheck` with the
  corrected text, which re-runs the full fact-check pipeline (internal
  sources + web fallback) against the new text and updates the same trigger's
  badge live via the existing `trigger-fact-check` WS message — no new
  message type needed, the recheck path reuses `broadcastTriggerFactCheck`.

## Improvements Phase §2: persistent meeting-state layer

- New `meeting_state` table (one row per session): `rolling_summary` (TEXT)
  + `open_items` (JSON array) + `last_updated_segment_count`. Deviates from
  the source doc's `last_updated_segment_id` FK — `TranscriptSegment` has no
  stable id anywhere in this codebase's domain layer (only the DB row does,
  and `getSegmentsForSession` doesn't even return it), so a plain count of
  segments processed so far is the simpler equivalent; `getSegmentsForSessionSince(sessionId, offset)`
  (`src/storage/segmentRepository.ts`) does the corresponding "give me
  everything after row N" query via `ORDER BY id ASC LIMIT -1 OFFSET ?`.
- Update cadence: every `MEETING_STATE_UPDATE_EVERY_SEGMENTS` (default 6)
  finalized segments, fire-and-forget from `session.ts`'s segment handler —
  never blocks live transcription/triggers. One Gemini call per update
  (`src/state/meetingState.ts`): given the previous summary + previous open
  items (with their ids) + only the new transcript slice, it returns an
  updated summary (merged, not appended) and the updated open-items list —
  the model itself decides what carries over unchanged, what's newly added,
  and what's resolved (simply omitted from the new list) — no separate
  diffing/resolution-detection logic needed on our side.
- **Verified end-to-end** with a synthetic two-round test: round 1 raised a
  question (ticket status) and a vague commitment (flaky pipeline); round 2
  answered the question and left the commitment untouched. Result: the
  question was correctly dropped from `openItems` after round 2 while the
  commitment persisted, and `rollingSummary` was genuinely merged (mentioned
  the resolution) rather than just concatenated.
- **Where it plugs in**: `getMeetingStateSnapshot(sessionId)` is a cheap
  synchronous-feeling read (just the last upserted row, no LLM call) used by:
  - `src/suggestions/generate.ts` — appends the rolling summary + open items
    to the suggestion prompt with an explicit instruction to output `SKIP` if
    the point is already an open item or already resolved per the summary.
    This is the "suppression" the source doc describes — implemented as a
    prompt instruction reusing the existing SKIP convention, not a separate
    duplicate-detection step, to stay consistent with this project's
    single-LLM-call-per-feature design.
  - `src/factcheck/factcheck.ts` — `factCheckClaim` now takes a `sessionId`
    param (was claim-text-only before) so the internal-source judgment call
    can note if a claim/conflict was already established earlier in the
    meeting, rather than treating a differently-worded restatement as new.
  - `src/qa/liveQa.ts` — rolling summary + open items added alongside the
    existing full-transcript-so-far context (not a replacement — removing the
    full transcript felt riskier than purely additive for the added value at
    typical meeting lengths; revisit if very long sessions make the full
    transcript context too large/slow).
  - **Deliberately NOT wired into** `src/triggers/classify.ts` (Stage 1 fast
    filter) — that module is explicitly documented as classifying "ONLY this
    window, not what a full conversation might imply," and threading meeting
    state into it risks reintroducing a different flavor of the same
    statelessness problem (stale context bleeding into a cheap, fast
    classification pass meant to stay narrow). The raw Triggers-tab log still
    shows every detection regardless — only the downstream *suggestion* is
    suppressed.

## Improvements Phase §3: voice/vocal emotion (Imentiv AI) — removed

- Was scaffolded (post-meeting, on-demand "Analyze voice emotion" button via
  Imentiv AI, successor to the sunset Hume AI Expression Measurement API) but
  never verified against a real API key, and has since been removed entirely
  at the user's request — `src/emotion/imentiv.ts`, `voiceEmotionRepository.ts`,
  the `voice_emotion_scores` table (dropped via migration in `db.ts`), the
  `/api/sessions/:id/analyze-emotion` + `/voice-emotion` endpoints, and the
  toolbar button/UI are all gone. Live tone-shift detection (Phase 3) was
  never affected either way — it stays on text-based Cloud Natural Language
  sentiment. If voice/vocal emotion analysis is wanted again later, treat
  this as a fresh build rather than resurrecting the old code — the vendor
  landscape here moves fast (Hume's own sunset is the reason Imentiv was
  being evaluated at all), so re-check what's actually available first.

## Improvement: live audio waveform indicator

- The source doc (`Improvement_LiveAudioWaveform.md`) assumes a browser-based
  architecture — tapping a `MediaStreamSource` from `getUserMedia` with the
  Web Audio API's `AnalyserNode`. **Doesn't apply here**: audio capture
  happens server-side via the SoX subprocess (`src/audio-capture/soxCapture.ts`);
  the browser is only a WebSocket-connected display client with no direct
  access to the audio stream at all.
- Adapted design (user chose the "true oscillogram" option over a cheaper
  level-meter alternative): the server downsamples each raw PCM chunk into a
  compact min/max envelope (`src/audio-capture/waveform.ts`,
  `computeWaveformEnvelope`) — one [min, max] pair per ~40th of the chunk,
  normalized to -1..1 — and broadcasts it over the existing WebSocket as a
  `waveform` message, rather than streaming full-resolution 16kHz samples to
  the browser (unnecessary bandwidth for a canvas that only has so many
  pixel columns to draw into anyway). Verified the downsampling math
  directly: mono and stereo-interleaved inputs both produced correctly
  scaled values, and channel 0 (mic) is confirmed to be what's picked out of
  an interleaved mic+system buffer (system channel is ignored for this —
  one waveform is enough to confirm capture is active, not a multi-track
  view).
- Canvas is positioned between the toolbar and tab bar (`#waveformCanvas`)
  so it's visible regardless of which tab is open, matching the doc's "top
  of the meeting session view" framing — a session-level trust indicator,
  not a Transcript-tab-specific one.
- Only rendered while viewing the session that's actually recording right
  now (`activeSessionId === liveSessionId`) — hidden for past sessions
  (nothing live to show) and cleared on every session switch/start so old
  audio doesn't visually bleed into a new session.
- Toggle: `WAVEFORM_ENABLED` (default true) — automatic during recording
  like sentiment/triggers, since the whole point is instant "is it actually
  listening" feedback; an on-demand version wouldn't serve that purpose.

## Speako 2.0: pre-meeting prep (calendar detection, type workflows, mem0 + MyRAG)

- **Architecture chosen**: seed `meeting_state.rolling_summary` directly with
  the synthesized prep brief (via a new `seedMeetingState` helper in
  `src/state/meetingState.ts`), rather than threading a separate `prepBrief`
  field through the pipeline. This meant **two** injection points, not one —
  suggestions (`src/suggestions/generate.ts`) already read meeting-state, so
  they picked up seeded context for free, but trigger classification
  (`src/triggers/classify.ts`) never read meeting-state at all before this —
  had to add that wiring explicitly (`TriggerDetector.onFinalSegment` now
  fetches the current snapshot and passes `rollingSummary` into
  `classifySegment`'s prompt). Easy to miss if you assume "seed meeting_state"
  automatically reaches everything that matters.
- **Verified end-to-end against real infra**, not just unit-level: prepping a
  real "standup" session with real Jira credentials configured produced a
  genuinely useful, correctly-structured brief (grouped by ticket status,
  real ticket keys) in ~6 seconds, and `meeting_state.rolling_summary` was
  confirmed seeded before any transcript existed. Latency for a single-source
  (Jira-only) standup workflow: ~6s from `POST /api/session/prepare` to
  `prep_status='ready'`. Not yet measured: sprint-review/design-dev workflows
  with 4-5 sources running concurrently — expect longer, still shouldn't
  block recording since prep runs fully async.
- **Partial-source-failure tolerance confirmed working, including the
  all-sources-empty case**: prepping a one-on-one session with `mem0-cloud`/
  `rag-cloud` unconfigured and no matching Jira results correctly produced
  `sourcesQueried: []`, a graceful "no prep context was found" brief, and
  `prep_status='failed'` — not a crash. Worth knowing: `prep_status='failed'`
  currently means "prep found nothing useful," not "prep errored" — those are
  conflated in the current status enum. Doesn't block starting the recording
  either way (never gated on prep status), but the label may read as more
  alarming than it is; consider splitting into a separate "empty" status if
  this causes confusion in practice.
- **Meeting-type classification** (`src/prep/meetingTypes.ts`) is signal-based
  (title/description keywords + recurrence + attendee count) against calendar
  events, defaulting to `generic` with no event at all — not yet validated
  against real calendar data (no calendar configured during this build/test
  pass), only unit-shaped. Manual override in the UI is the load-bearing path
  today, exactly per the "misclassification should fail toward generic"
  design intent — don't trust auto-classification blindly until it's been
  run against a real calendar for a while.
- **Calendar integration is a poller, not a scheduler**: `listUpcomingEvents`
  + the "prep this meeting" shortcuts only work while Speako is actually
  running at the time — there's no background service, no OS-level scheduled
  task. If Speako isn't open 15 minutes before a meeting, the shortcut never
  appears (you can still prep manually via the meeting-type picker). This was
  a known, accepted limitation going in, not a bug discovered late.
- **mem0-cloud/rag-cloud reuse the existing `McpServerClient`**, generalized
  to a `{transport: 'stdio'|'http'}` discriminated config rather than a
  parallel class — the SDK's `StreamableHTTPClientTransport` (already present
  in the installed `@modelcontextprotocol/sdk` version, no new dependency)
  is a drop-in swap at the one transport-construction call site; `listTools`/
  `callTool`/lazy-connect memoization needed zero changes.
- **Post-meeting mem0 write-back is capped at 3 facts per summary** (key
  decisions + up to 2 explicit-confidence action items), deliberately, to
  avoid the memory store filling with transcript-derived noise — not yet
  observed over enough real meetings to judge whether 3 is the right number
  or whether the fact-quality (one sentence, no meeting-name context beyond
  a quoted title) is actually useful on recall days/weeks later. Worth
  revisiting once there's real usage history to look at.
- **Bug found by the new unit tests, fixed**: `findLikelyPreviousSession`'s
  `ORDER BY started_at DESC` alone is non-deterministic for sessions created
  within the same second (SQLite's `datetime('now')` is second-resolution) —
  ties resolved in an arbitrary order rather than true insertion order,
  caught by `tests/prep.test.ts` asserting the *actual* most-recent session
  won. Fixed by adding `, rowid DESC` as a tie-break. Low real-world impact
  (prepping two same-subtype sessions within the same second is rare) but a
  genuine correctness bug, not just a test artifact.
- **Qualitative before/after on suggestion quality**: not yet assessed with a
  real live recording (this build/test pass only exercised the prep endpoints
  directly, not a full prepped-session recording start-to-finish) — the
  meeting-state seed and trigger-context wiring are confirmed *present* in
  the prompts, but "does this actually make suggestions better" needs a real
  meeting to judge, not just an API-level check.

## Local codebase indexing for design/dev prep

- **Strategy pivot from an earlier plan**: the first version of this feature
  cloned Bitbucket repos into `rag-mcp-server`/MyRAG (a remote Cloud Run +
  Qdrant service), which would have meant provisioning git-clone credentials
  in GCP and shipping source code to a remote service. Rejected in favor of
  reusing Speako's own existing RAG pattern (`src/rag/rag.ts`:
  chunk → Gemini-embed → local SQLite → brute-force cosine search) pointed at
  local source files instead of transcript segments — no new services, no
  credentials, source code never leaves the machine except the text sent to
  Gemini for embedding. The right call given Speako already runs entirely
  locally on the user's own dev machine, where these repos are already
  checked out for their actual job.
- **`local_codebase` is additive to `myrag_external_refs`, not a replacement**
  in `designDev.ts` — MyRAG keeps its originally-intended role of one-off
  *external* references (linked specs, competitor docs); the team's own
  codebase is a distinct, local-only concern with a different trust boundary.
- **One Gemini embed call per chunk**, same one-at-a-time pattern
  `indexSessionForRag` already uses — deliberately not batched. This mirrors
  already-working code rather than reintroducing the 100-item/call Gemini
  batch cap `rag-mcp-server` had to work around; fine at personal-codebase
  scale, would need revisiting if this indexed something much larger.
- **`indexCodebase.ts` isolates failures per configured repo path** (own
  try/catch per repo, not a single try/catch around the whole loop) — a bad
  or since-moved path shouldn't block indexing the rest of `CODEBASE_LOCAL_PATHS`.
- Not yet verified end-to-end against a real checked-out repo in this pass —
  schema, chunker, indexer, search, wiring, endpoints, and UI are all written
  and typecheck-clean, but no real `CODEBASE_LOCAL_PATHS` run has confirmed
  `code_chunks` populates correctly or that `searchCode()` surfaces a real,
  recognizable function/class from an actual local repo.

## Native Microsoft Graph ingestion (Outlook + Teams)

> **Superseded.** This whole approach (direct Graph API + MSAL device-code
> auth, plus the Outlook-desktop-COM and Teams-Playwright fallbacks below)
> was later replaced by the Microsoft 365 Claude connector — headless
> `claude` CLI dispatch via `src/integrations/claudeConnectorCli.ts`, used by
> `outlookMailSync.ts`, `microsoft365Calendar.ts`, and `teamsConnectorSync.ts`.
> None of the code described in this section or the two that follow it still
> exists; kept here only as a historical record of what was tried and why.

- **Replaces the need for the external daily-agent** described in
  `docs/EXTERNAL_INGESTION_PROMPT.md` for anyone who can register their own
  Azure AD app — `src/integrations/msGraphSync.ts` fetches directly and
  upserts into the same `external_messages` table via the same
  insert-then-`ON CONFLICT`-reset-`indexed_at` contract that doc specifies,
  so the existing chunk/embed step (`indexExternalMessages.ts`, "Index
  communications" button) needed zero changes. Both paths can run
  side-by-side — kept the doc rather than deleting it, since not everyone can
  create an app registration, and it's the only option for sources Graph
  doesn't cover.
- **Device-code flow, not the redirect-server flow `gcal-auth.ts` uses** —
  deliberately different from the Google Calendar precedent. A device code
  only needs the app registration to allow "public client flows"; no redirect
  URI to register, no local port to coordinate. Traded a slightly less slick
  one-time setup (copy a code, open a URL) for one fewer moving part.
- **Chat.Read only, not `ChannelMessage.Read.All`** — deliberately scoped to
  1:1/group chats, not Teams channel posts. In most Microsoft 365 tenants,
  channel-message permissions require a tenant admin to grant consent before
  any user can authorize them; `Chat.Read` (and `Mail.Read`) are both
  user-consentable, so the one-time `npm run msgraph-auth` sign-in doesn't
  block on IT. Revisit if channel coverage turns out to matter — it would be
  an additive scope + a second fetch function, not a rewrite.
- **msal-node has no built-in persistent token cache** (unlike `googleapis`,
  which just wants a plain JSON token blob on disk) — needed a small
  `ICachePlugin` (`msGraphAuth.ts`'s `fileCachePlugin`) that serializes
  MSAL's cache to `MS_GRAPH_TOKEN_PATH` on change and deserializes it back in
  on every `PublicClientApplication` construction. `isMsGraphConfigured()`
  just checks that file exists — mirrors `isCalendarConfigured()`'s
  credentials-file-exists check.
- **Teams chat message fetching has no server-side date filter** — the
  `/chats/{id}/messages` endpoint doesn't support `$filter` on
  `createdDateTime` the way `/me/messages` does for email, so
  `fetchRecentChatMessages` fetches one page (`$top=50`) per chat and filters
  client-side. A chat with more unread-since-cutoff messages than that in one
  poll window will miss the overflow — accepted for a 15-minute default poll
  cadence (`MS_GRAPH_POLL_MINUTES`); would need real pagination if the
  interval were made much longer.
- **Overlap-window polling, not since-last-sync** — every run looks back
  `MS_GRAPH_LOOKBACK_HOURS` (default 48) regardless of when the previous run
  succeeded, same rationale `EXTERNAL_INGESTION_PROMPT.md` already gives for
  the manual path: a missed run (token expired, app closed) shouldn't create
  a silent gap, and re-upserting an already-seen message is a no-op cost
  since `upsertExternalMessage`'s `ON CONFLICT` update is idempotent.
- **Now verified against a real Azure AD app registration + real tenant** —
  found and fixed two real issues, both worth knowing about before anyone
  else sets this up:
  - **`MS_GRAPH_TENANT_ID=common` fails device-code sign-in with
    `AADSTS50059` ("No tenant-identifying information found") for a
    single-tenant app registration** ("Accounts in this organizational
    directory only"). `common` only works for *multi-tenant* app
    registrations. Confirmed by calling the `/common/oauth2/v2.0/devicecode`
    endpoint directly and comparing against the same call with a specific
    tenant GUID — the fix is to set `MS_GRAPH_TENANT_ID` to the tenant ID
    shown on the app registration's Overview page (not the tenant implied by
    the user's email domain, which can differ from where the app itself is
    registered — this bit us during setup: `login.microsoftonline.com/{mail-domain}/v2.0/.well-known/openid-configuration`
    resolved to a *different* tenant GUID than the app registration lives
    in). config.ts's default stays `common` since most people registering
    fresh will pick single-tenant and hit this immediately — worth calling
    out prominently in setup docs, which was added to README.md.
  - **`msal-node`'s `DeviceCodeClient.getDeviceCode()` silently swallows the
    real AAD error body** on the initial device-code request — it
    destructures the expected `user_code`/`verification_uri`/etc. fields
    directly out of the response without checking for an `error` field
    first, so a 400 error response (like the `AADSTS50059` above) becomes a
    `DeviceCodeResponse` of all-`undefined` fields instead of a thrown
    error. The failure only surfaces later, confusingly, as
    `post_request_failed: invalid_grant` from the *token polling* step
    (since it ends up polling with an undefined device code). Worked around
    by calling the device-code endpoint directly with `Invoke-RestMethod`
    to see the real error body when this class of failure ever recurs —
    `scripts/msgraph-auth.ts`'s catch block also now logs
    `err.errorCode`/`err.subError`/`err.errorMessage` for whatever detail
    msal-node does surface.
  - **Real-account finding, root-caused (not a code bug): both mail and
    Teams failures traced to a single cause — signing in as a B2B guest**.
    Email sync failed with `MailboxNotEnabledForRESTAPI` ("mailbox
    is...hosted on-premise") and Teams chat sync failed with a bare `401
    Unauthorized` on `/me/chats` despite the token verifiably having
    `Chat.Read` granted (confirmed via `acquireTokenSilent(...).scopes`).
    Initially suspected as two independent causes (hybrid Exchange; missing
    Teams license) — actually one cause, confirmed by adding `User.Read` to
    `MS_GRAPH_SCOPES` and calling `GET /me`: the signed-in account's
    `userPrincipalName` was `...#EXT#@<tenant>.onmicrosoft.com` — the `#EXT#`
    marker means this identity is a **B2B guest** in that tenant, not a
    native member. `GET /me/licenseDetails` confirmed zero licenses, which
    is expected for a guest (licenses live in the guest's home tenant, not
    the one they're a guest in). A guest identity has no real mailbox or
    first-class Teams presence in the host tenant, so both failures are
    downstream of the same identity mismatch — the fix is signing in with
    the account's actual home-tenant credentials, not an org-account
    reachable only as a guest elsewhere. `msGraphSync.ts`'s per-source
    try/catch (email failing independently of Teams) is what let both
    symptoms surface cleanly enough to spot they shared one root cause
    instead of one failure masking the other.
  - **`User.Read` added to `MS_GRAPH_SCOPES`** specifically to make this kind
    of self-service diagnosis possible next time (`GET /me`,
    `GET /me/licenseDetails`) — not used by the sync itself. Virtually always
    pre-approved on an app registration, so it doesn't add real consent
    friction.
  - `graphGet()` in `msGraphSync.ts` was updated to include the response
    body text in thrown errors (previously just status/statusText) — the
    body is where AAD/Graph's actual error code and human-readable message
    live, and status alone (e.g. bare "401 Unauthorized") isn't actionable.

## Outlook desktop COM automation fallback

- **Why this exists at all**: the guest-account finding above means Graph's
  Mail API is a dead end for this specific setup no matter which scopes are
  requested — the account has no real mailbox in that tenant, full stop. A
  genuinely different mechanism was needed: `scripts/outlookExport.ps1` +
  `src/integrations/outlookDesktop.ts` read mail through classic desktop
  Outlook's own COM automation object model instead of any cloud API, so it
  rides whatever connection the locally-configured Outlook profile already
  has — irrelevant whether that's Exchange Online, hybrid, on-prem, or a
  guest-tenant quirk, since it's not going through Graph at all.
- **"New Outlook" has no COM automation support** — Microsoft's newer
  PWA-style Outlook client doesn't expose the classic `Outlook.Application`
  COM object at all, so this fallback only works with classic desktop
  Outlook. There's no cheap way to detect which one is installed from
  Node/PowerShell short of actually trying `New-Object -ComObject
  Outlook.Application` and seeing what happens — `isOutlookDesktopConfigured()`
  only checks `process.platform === 'win32'`, a necessary-but-not-sufficient
  gate; a real mismatch surfaces as a clear failure when the sync actually runs.
- **Shells out to `powershell.exe`, doesn't use a Node COM binding** —
  deliberately, to avoid adding a native-binding dependency (`winax`,
  `edge-js`, etc.) that would need node-gyp/native compilation and could
  break across Node/Electron version bumps. Matches this codebase's existing
  precedent of shelling out to external tools (bundled SoX binary, `uvx
  mcp-atlassian`) rather than binding to them in-process.
- **Outlook's "Object Model Guard" shows an interactive security prompt**
  ("A program is trying to access e-mail information...") the first time an
  external process touches mail via COM in a session — this is why the
  sync is manual-button-only (Settings' "Sync via Outlook desktop"), not a
  background poll like the Graph sync. An unattended timer could stall
  indefinitely behind a prompt nobody's watching for.
- **Iterate-and-break instead of a DASL `Items.Restrict()` filter** for the
  date cutoff — `Restrict()`'s date-filter syntax is locale-dependent
  (`"[ReceivedTime] >= 'mm/dd/yyyy h:mm AM/PM'"` in the *Outlook client's*
  locale, not ISO), which is exactly the kind of environment-fragile string
  formatting worth avoiding. `Items.Sort("[ReceivedTime]", true)` (descending)
  + breaking on the first item older than the cutoff is locale-proof and
  plenty fast for a 48h inbox window.
- **Resolves SMTP addresses via `GetExchangeUser().PrimarySmtpAddress`**,
  falling back to `.Address` — Exchange accounts' raw `.Address`/
  `.SenderEmailAddress` is often an internal Exchange DN
  (`/O=.../CN=RECIPIENTS/CN=...`), not a usable SMTP address, for on-prem/
  hybrid mailboxes especially. Not yet verified against a real hybrid
  mailbox in this pass (built and unit-tested against synthetic item shapes
  only) — worth confirming the DN-resolution path actually fires correctly
  the first time this runs against real mail.
- **Per-item try/catch inside the PowerShell loop**, matching
  `indexCodebase.ts`/`bitbucketServer.ts`'s per-unit resilience convention —
  one malformed/corrupted mail item shouldn't abort the whole export.
- Mail body comes back already-plain-text (`MailItem.Body`), unlike Graph's
  HTML bodies — no `htmlToPlainText()` equivalent needed for this path.
- **Verified end-to-end against real Outlook — found and fixed two real
  `ConvertTo-Json` bugs specific to Windows PowerShell 5.1** (`powershell.exe`,
  not the `pwsh` 7+ used elsewhere in this project):
  - `-AsArray` (the obvious fix for "a 1-item array gets serialized as a bare
    scalar, not `[x]`") doesn't exist before PowerShell 6.2 — using it against
    `powershell.exe` throws `ParameterBindingException` immediately.
  - The next-obvious fix, prefixing with a leading comma (`,$results |
    ConvertTo-Json`, the standard array-preserving idiom on 6.2+), is
    actively **wrong** on 5.1 — confirmed by direct reproduction: it
    serializes the array as `{"value":[...],"Count":n}` instead of a plain
    JSON array, for *any* size (tested with 2 and 10 items, not just 0/1).
    Converting from `ArrayList` to a real `Object[]` via `.ToArray()` first
    didn't help either — same wrapped shape.
  - The actual, empirically-confirmed 5.1 behavior: piping a 2+-item array
    directly serializes correctly (`[1,2,3]`); piping a 1-item array
    unwraps to a bare scalar (`1`); piping an empty array produces empty
    output (not `[]`). No single idiom covers all three sizes on this
    PowerShell version, so `outlookExport.ps1` branches explicitly on
    `$results.Count` (0 → literal `"[]"`; 1 → manually bracket one
    `ConvertTo-Json` call; 2+ → pipe directly) instead of trusting a trick.
  - Also found via a real run: `([DateTimeOffset]$item.ReceivedTime).UtcDateTime.ToString("o")`
    (round-trip format) emits 7 fractional-second digits
    (`...42.3620000Z`), which sorts incorrectly as TEXT against other
    sources' 3-digit/no-fraction timestamps (Graph's `receivedDateTime`,
    JS's `toISOString()`) — a longer digit string isn't a valid
    lexicographic continuation of a shorter one at the same position. Fixed
    by formatting explicitly as `"yyyy-MM-ddTHH:mm:ss.fffZ"` (3-digit ms,
    matching `toISOString()`) instead of relying on `"o"`.
  - End-to-end verified for real: 10 real inbox emails synced correctly into
    `external_messages` (unindexed, correct titles/SMTP participants/UTC
    timestamps) via the actual `POST`-route code path
    (`syncOutlookDesktop()`), not just the raw PowerShell script in
    isolation.

## Teams chat via local client cache — investigated, shelved

- Confirmed the new (MSix-packaged, `MSTeams_8wekyb3d8bbwe`) Teams client
  does cache conversation data locally: an ~88MB IndexedDB LevelDB store for
  `teams.microsoft.com` under
  `%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\EBWebView\WV2Profile_tfw\IndexedDB\`.
  This was explored as a fallback for Teams chat after Microsoft Graph's
  `/me/chats` turned out to be blocked by the guest-account issue (see the
  native-Graph-ingestion section above) and there's no Outlook-equivalent
  COM automation object model for Teams.
- **Deliberately not built**: extracting readable messages from this store
  requires two separate hard problems, neither of which is a stable public
  API like Outlook's object model — (1) a native LevelDB reader dependency,
  and (2) decoding Chromium/Blink's internal IndexedDB value serialization
  format (V8's structured-clone wire format), which is undocumented by
  Microsoft/Google for this purpose and tied to whatever internal object
  shape the Teams web client happens to use for its conversation cache —
  liable to silently break on any Teams update with zero warning. A
  known-good open-source forensic parser for this exact format exists
  (`ccl_chromium_reader` / `ccl_chrome_indexeddb` on GitHub, Python,
  installed successfully via `pip install
  git+https://github.com/cclgroupltd/ccl_chrome_indexeddb.git` during
  investigation) — reusing it would have been far more reliable than a
  from-scratch TypeScript reimplementation of an undocumented binary format
  from memory.
- **Stopped before extracting any real data**: the next step (copying the
  live IndexedDB files to a safe temp location, since they're locked while
  Teams is running) was blocked by Claude Code's auto-mode safety
  classifier — reading/copying out of another app's private
  Windows-app-container sandboxed data directory is a reasonable thing to
  flag, and the user chose to shelve the whole approach rather than grant
  an exception. No code exists for this in the repo; this note exists so a
  future attempt doesn't have to re-derive the recon from scratch.
- If revisited: the pragmatic path is almost certainly shelling out to a
  Python script using `ccl_chromium_reader` (matching this codebase's
  existing "shell out to an external tool" convention — SoX, PowerShell for
  Outlook) rather than porting the parser to TypeScript, and it should only
  ever run against a **copy** of the IndexedDB files, never the live
  directory, to avoid any risk of corrupting Teams' actual data while it's
  running.

## Bitbucket pull-request review activity

- **Extends the existing REST integration, not a new auth mechanism** —
  reuses `BITBUCKET_SERVER_URL`/`USERNAME`/`TOKEN` as-is. Motivated by a
  specific ask: "PRs assigned to me as reviewer, and comments from
  reviewers on my PRs or where I'm mentioned."
- **`/rest/api/1.0/dashboard/pull-requests?role=X&state=Y` is repo-agnostic**
  — unlike `searchBitbucketServer`'s commit/file search, this doesn't need
  `BITBUCKET_SERVER_REPOS` at all; it returns PRs across every repo the
  authenticated user (whichever account the configured token belongs to)
  can see, filtered by their role (`REVIEWER`/`AUTHOR`) on each PR. Much
  simpler than iterating configured repos.
- **No true "mentioned in comments" search exists on this API** — Bitbucket
  Server has no cross-repo/global comment search (consistent with the
  already-broken server-wide code search noted in the Phase 4 section
  above). `bitbucketReviews.ts`'s `mentionsMe()` is a heuristic:
  case-insensitive `@username` substring match over comments on PRs the
  user is *already* involved in (authored, or asked to review) — a real
  limitation, documented in the README, not a bug. Someone mentioning you
  on a PR you have zero involvement in would be missed entirely.
- **Approval status is looked up by matching `bitbucketServerUsername`
  against each PR's `reviewers[].user.name`** (Bitbucket's internal account
  name, not display name/email) — case-insensitive, since Bitbucket Server
  account names have historically been case-insensitive for auth purposes
  and there's no guarantee the configured username's casing matches exactly
  what the API echoes back.
- **New `ToolKey` (`bitbucketReviews`), separate from the existing
  `bitbucket` key** — deliberately not folded into `searchBitbucketServer`,
  because it isn't a keyword search over commits/files; it's a fixed
  "what's my current PR activity" lookup (same shape as `webSearch`
  ignoring its `limit` argument — `TOOL_CATALOG.bitbucketReviews` ignores
  both `query` and `limit`). Wired into both the voice-chat tool catalog
  (`VOICE_TOOL_KEYS`) and the Sprint Planning/Sprint Review prep workflows,
  per the explicit ask to cover both.
- **Verified against real Bitbucket PR/reviewer data**: the documented,
  stable, versioned Bitbucket Server REST API 1.0 shapes
  (`dashboard/pull-requests`, per-PR `activities`) worked correctly on the
  first real run — 6 real open PRs assigned as reviewer came back
  correctly-shaped via `tests/integration/bitbucket.test.ts`, no empirical
  recon needed first (unlike the Teams IndexedDB case above, an
  undocumented format).

## Outlook desktop calendar fallback (meeting auto-detection)

- **Same COM automation rationale as the email fallback** —
  `scripts/outlookCalendarExport.ps1` reads classic Outlook's Calendar
  folder (`GetDefaultFolder(9)`), returning the exact `CalendarEvent` shape
  `googleCalendar.ts`'s `listUpcomingEvents` already returns, so
  `classifyMeetingType()` and every other consumer of "upcoming events"
  work unchanged regardless of which source produced them.
- **Deliberately not merged with Google Calendar** — per explicit
  direction, this is a standalone fallback: `server.ts`'s
  `/api/calendar/upcoming` tries Google Calendar first if configured, and
  only falls back to Outlook desktop if Google isn't set up. No dedup, no
  combined view of both sources at once. `googleCalendar.ts` itself was not
  touched.
- **Real, significant performance bug found and fixed via direct
  measurement, not assumption**: a naive `foreach` + early-break over
  `Items` with `IncludeRecurrences = $true` took **over a minute** on a
  real calendar with years of recurring meetings (SCRUM standups, etc.) —
  confirmed by timing it directly, not by reading Microsoft's docs and
  guessing. Root cause: enabling `IncludeRecurrences` forces Outlook to
  expand every recurring series before any iteration can happen, and
  walking a `Sort`-ascending collection from the *earliest* expanded
  occurrence forward means passing through **every past occurrence ever**
  before reaching "now," regardless of how small the actual look-ahead
  window is or where the loop's `break` condition sits. Fixed by calling
  `Items.Restrict()` **after** `IncludeRecurrences`/`Sort` (Microsoft's
  documented required ordering) so Outlook filters by date range
  internally instead of the script walking every historical instance —
  confirmed via direct timing: **same query, same real data, ~9 seconds**
  (and this cost doesn't scale with window size — a 15-minute window and a
  7-day window both took ~8-9s, confirming it's a fixed per-call COM/folder-
  scan cost, not proportional to what's returned).
- **`Items.Restrict()`'s date filter is locale-dependent** (`.ToString("g")`,
  the current user's short date/time format) — a deliberate, documented
  exception to the locale-proof "iterate and break" approach the email
  export uses (`outlookExport.ps1`). Recurrence expansion makes `Restrict`
  a practical necessity for Calendar specifically, not just an
  optimization; email's Inbox doesn't have this problem since a
  descending-sorted, non-recurring Inbox never requires walking years of
  history to find "recent."
- Verified end-to-end for real: 16 real upcoming meetings (SCRUM standups,
  design meetings, cancelled series, etc.) returned correctly — right
  titles, correctly-expanded recurring instances, correct UTC start times,
  correct attendee counts — via the actual PowerShell script directly (not
  yet via the full `listUpcomingOutlookEvents()` → `/api/calendar/upcoming`
  path in this pass; `tests/integration/outlookCalendar.test.ts` covers
  that layer, gated on `isOutlookDesktopConfigured()`).

## Sidebar history tabs (Meetings / Practice / Chat)

- **New `session_kind` column, orthogonal to the existing `session_type`**
  (`personal`/`work`, meetings-only) — `'meeting' | 'practice' | 'chat'`,
  defaulting to `'meeting'`. Deliberately a separate column rather than
  overloading `session_type`'s existing two values, since `session_type`'s
  personal/work distinction still means something specific for real
  meetings (Work sessions get pre-meeting prep) and doesn't apply to
  chat/practice at all.
- **Chat sessions used to be fully ephemeral by design** — `startVoiceSession`'s
  own doc-comment said so outright ("mode 'chat': ephemeral, no session
  created"). Explicitly changed after confirming with the user: chat now
  persists a real session + transcript the same way practice already did,
  specifically so it has something to show in a history tab at all. This is
  a real behavior change (chat sessions now leave a permanent transcript
  record on disk, same privacy posture as any recorded meeting) — not a
  pure UI addition.
- **Generalized practice-only persistence into one shared code path** —
  `startVoiceSession`/`stopVoiceSession` used to have `practiceSessionId`/
  `flushPracticeTranscript` fields hardcoded to the practice case only. Now
  `persistedSessionId`/`persistedSessionKind`/`flushTranscript` cover both
  modes identically (same debounced-flush transcript buffering, same
  `insertFinalSegment` calls), branching only on `persistedSessionKind` for
  the two things that actually differ: the assistant's speaker label
  ("Practice Partner" vs "Assistant") and whether to run
  `analyzeConversation`/coaching feedback on stop (practice only — a chat
  session is a Q&A log, not a roleplay run to critique).
- **Migration backfills existing practice sessions** using the only signal
  that existed before this column: `UPDATE sessions SET session_kind =
  'practice' WHERE name LIKE 'Practice: %'` (the cosmetic name prefix
  `startVoiceSession` has always used). One-time, best-effort recovery for
  whatever's already in a real `speako.db` — not a permanent
  identification mechanism (a real session named literally "Practice: ..."
  by the user would also match, a rare but real false-positive risk judged
  acceptable for a one-time backfill).
- **No source-session link column added** — a practice session's only
  connection to the meeting it was practicing for is still the cosmetic
  `"Practice: ${source.name}"` name prefix; there's no structured
  `source_session_id` anywhere in the schema. Out of scope for this
  specific ask (tabs to *see* chat/practice history), flagged here as a
  gap worth closing later if "jump from a practice session back to the
  meeting it was based on" ever becomes a real ask.
- Sidebar tab bar (`#sessionKindTabs`, `.kind-tab-btn`) filters the
  already-fetched `sessions` array client-side by `sessionKind` rather than
  adding a server-side query param — consistent with `listSessions()`'s
  existing "fetch everything, filter in memory" simplicity (personal-scale
  session counts don't justify a new filtered endpoint).
- **Real bug found via live browser testing, fixed**: `stopVoice()`'s
  `refreshSessions()` call was gated on `wasPractice && practiceId` only —
  a leftover from when chat was ephemeral and had nothing to refresh for.
  After making chat persist too, stopping a chat session left the sidebar
  showing "No chat sessions yet." until a manual page reload, even though
  the session was correctly saved server-side the whole time (confirmed via
  `GET /api/sessions` directly during debugging — this was a pure frontend
  staleness bug, not a persistence bug). Fixed by refreshing on stop for
  *any* voice session (`wasVoiceSession = !!voiceMode`), keeping the
  practice-only Coaching-tab jump as the one thing that still branches on
  `wasPractice` specifically.
- Verified end-to-end for real via a live browser: started and stopped two
  actual chat sessions, confirmed each appeared immediately in the Chat tab
  post-fix (no reload needed), confirmed the transcript rendered correctly
  with "You"/"Assistant" speaker labels, and confirmed the migration
  backfill correctly recovered a pre-existing real `"Practice: session"`
  (63 segments) into the Practice tab on first load after the schema change.

## Speako is work-only — "Personal" one-click mode removed

- **Explicit product decision, not a refactor of convenience** — the user
  asked directly for Speako to be work-only. Removed the Personal/Work
  toggle from the new-session modal entirely (`#sessionTypeToggle`,
  `#personalTypeBtn`/`#workTypeBtn`, the `setSessionType()` function, the
  `sessionType` JS state var) along with the one-click "Start new session"
  button/handler (`#startBtn` and its click listener) — `#workPrepBox`
  (meeting-type picker, prep) is now unconditionally visible and is the
  only path to creating a new session.
- **Real latent bug this surfaced and fixed**: `createSession()`'s
  `prep_status` was derived from `options?.sessionType === 'work' ? 'pending'
  : 'none'` — i.e., `sessionType` doubled as "does this session want prep."
  Once every session became `'work'`, that check would have made
  `session.ts`'s direct-start path (`POST /api/session/start` with no prior
  `/api/session/prepare`) permanently show `prep_status: 'pending'` with no
  prep workflow ever running to resolve it — a stuck "preparing…" badge
  forever. Fixed by adding an explicit, independent `prepStatus` option to
  `CreateSessionOptions` (defaults `'none'`) — only `/api/session/prepare`'s
  call site passes `'pending'` now; `sessionType` no longer has any
  side-channel meaning beyond the label itself. This is exactly the kind of
  bug that's invisible in a diff (both old and new code "looked reasonable")
  and would only have surfaced once `session.ts`'s path was actually
  exercised without prep — caught by tracing through the logic during this
  change, not by a test failure.
- **`sessionType: 'personal'` retained as a historical value only** — the
  TypeScript union (`'personal' | 'work'`) still includes it (existing rows
  need to remain representable/readable), and `createSession()`'s default
  changed from `'personal'` to `'work'`. Practice/chat session creation
  (`server.ts`) had its explicit `sessionType: 'personal'` removed entirely
  now that it's vestigial — `sessionType` never drove any behavior for
  those two kinds (confirmed by `sessionKind` being the real discriminator
  for the sidebar tabs), so they now just default to `'work'` like
  everything else, simplifying those two call sites.
- **Existing personal *meeting* rows deleted per explicit user request** —
  29 rows matching `session_type = 'personal' AND session_kind = 'meeting'`
  were removed via a one-off script that called the real `deleteSession()`
  transaction per row (not a raw `DELETE FROM sessions`), so every related
  table (segments, summaries, action items, sentiment, triggers,
  suggestions, fact-checks, live queries, meeting-state, prep briefs,
  coaching feedback, chapters) was cleaned up consistently — same
  cascading-delete logic the single-session UI delete button already uses.
  **Deliberately filtered on `session_kind = 'meeting'` too, not just
  `session_type = 'personal'`** — practice/chat rows also carried
  `session_type = 'personal'` at the time (before the simplification above),
  and a naive `session_type`-only filter would have deleted the one real
  practice session from recent testing along with the intended stale
  meetings. Verified via `GET /api/sessions` before and after: 29 deleted,
  the 1 practice row and all 4 real work meetings confirmed untouched.
- Google Calendar's `classifyMeetingType()` has zero dependency on
  `sessionType` (confirmed via code inspection before making this change,
  not assumed) — nothing in the meeting-type-classification or prep-workflow
  logic needed to change; the only real wiring was the UI/creation-path
  change plus the `prep_status` decoupling above.

## "Implement with Claude Code" (action items → real code changes)

- **Motivating ask, verbatim**: some action items are code changes, and the
  user wanted Speako to be able to invoke the `claude` CLI to actually make
  them — with one hard constraint stated up front: "no commit or push
  action are allowed unless approved." That constraint shaped the entire
  design; this is not a "run arbitrary shell commands" feature.
- **Every mechanic below was verified against the real `claude` CLI on this
  machine before writing any Speako code** — not assumed from `--help` text
  alone, which turned out to matter (see the `--bg`/`--print` conflict
  below, discovered only by actually running the command). All testing used
  disposable temp git repos created and destroyed within the test/session,
  never `officercc` or any real project.
- **The actual hard-block mechanism, confirmed empirically**:
  `claude --bg "<prompt>" --worktree --permission-mode acceptEdits
  --disallowedTools "Bash(git commit:*)" "Bash(git push:*)"` — asked a real
  agent to both create a file *and* commit it. Result: the file edit landed
  (`acceptEdits`), but the commit was flatly denied — `git log` showed no
  new commit, the file sat as an untracked change. This is what makes "no
  commit/push unless approved" a real guarantee enforced by Claude Code's
  own permission system, not a prompt-level suggestion the agent could
  ignore or a Speako-side check that could be bypassed by calling the CLI
  differently.
- **`--bg` and `-p/--print` are mutually exclusive** — a real, specific CLI
  error ("--bg and --print conflict: --print never starts the interactive
  session that `claude agents` attaches to, so the job would be
  unattachable"), not a guess. Background dispatch uses the bare prompt as
  a positional argument, never `-p`.
- **`--worktree` auto-creates a new git worktree with a randomly-generated
  name** (e.g. `.claude/worktrees/lazy-hatching-wombat`) — Speako never
  needs to name or manage this itself; the worktree's path is discoverable
  afterward via `claude agents --json`'s `cwd` field for that session.
- **`claude agents --json --all` is the polling mechanism** — confirmed two
  concrete terminal `state` values by direct observation: `"done"` (clean
  success) and `"blocked"`. The CLI's own `--help` text doesn't enumerate
  possible state values anywhere, so `pollCodeChangeRequest` treats
  anything unrecognized as "still running" rather than guessing wrong and
  failing a task that's actually still in progress.
- **`"blocked" is NOT a reliable failure signal on its own — found the hard
  way in a live end-to-end smoke test, after the initial design assumed
  it always meant failure.** A normal, successful run — file edited, then
  the agent tries the (intentionally denied) `git commit` as its natural
  last step — *also* ends in state `"blocked"`, with a perfectly good diff
  sitting in the worktree. The original polling logic treated every
  `"blocked"` as a hard failure and discarded that diff. Fixed by treating
  `"done"` and `"blocked"` the same way: always try `getWorktreeDiff()`
  first, and only mark the request failed if that diff comes back empty.
  `"stopped"/"failed"/"error"` still fail immediately — there's nothing to
  double-check a diff against there.
- **`--permission-mode acceptEdits` alone was flaky for brand-new file
  creation** — also found via the live smoke test, not assumed. The exact
  same command (`--bg ... --permission-mode acceptEdits --disallowedTools
  ...`) sometimes silently created the file and sometimes left the agent
  hung forever on an interactive "Do you want to create hello.txt?" prompt
  it can never answer in `--bg` mode (no TTY). Adding an explicit
  `--allowedTools "Write" "Edit"` alongside `acceptEdits` closed the race
  in every rerun after that. The disallowed-tools hard-block for git
  commit/push is unaffected — confirmed still denied with `allowedTools`
  set.
- **A worktree still locked by a live or just-stopped Claude session needs
  `git worktree remove --force --force` — twice, not once.** A single
  `--force` only overrides the "worktree is dirty" check; it still refuses
  with "cannot remove a locked working tree" until force is passed twice.
  `discardCodeChangeTask()` was updated accordingly.
- **`claude rm <id>` deliberately refuses to remove a worktree with
  uncommitted changes** (confirmed via a real test — "kept aed7b73c —
  worktree has uncommitted changes... resolve that (commit/push, or remove
  the worktree), then run 'claude rm aed7b73c' again"). Discarding a
  change *is* choosing to throw those changes away, so
  `discardCodeChangeTask()` deliberately bypasses this by calling
  `git worktree remove --force` directly instead of `claude rm` — the right
  call for this specific case, not a workaround for a bug.
- **Diff capture requires `git add -A` before `git diff --cached`, not a
  bare `git diff`** — a plain `git diff` only shows already-tracked
  modifications; new/untracked files (the common case for an agent creating
  a new file) don't show up at all without staging first. `getWorktreeDiff()`
  stages everything in the worktree (never commits — that stays hard-blocked
  regardless) purely to produce a complete, appliable diff.
- **The diff is captured once and stored in the DB at 'ready' time**
  (`code_change_requests.diff`), not re-read live at approval time — so
  clicking "Approve & Commit" still works correctly even if the worktree
  has since been cleaned up independently. Approval applies that stored
  diff via `git apply` against the *real* repo and commits there — this is
  Speako's own controlled git operation, never something the Claude Code
  agent does itself.
- **Commit and push are two separate, explicit gates**, not one bundled
  "approve" action — `POST .../approve` only commits;
  `POST .../push` is a distinct later call, only enabled once status is
  `'applied'`. Read literally from the user's stated constraint: committing
  and pushing are both things that need approval, treated as two decisions
  a human has to make, not one.
- **Polling lives in `server.ts`, not a database timer/cron** — a simple
  recursive `setTimeout` loop per request (10s interval, 20-minute cap),
  matching this codebase's existing lightweight-poller conventions
  (`checkScheduledSessions`, `checkIdleVoiceSessions`) rather than
  introducing a new scheduling mechanism for what's fundamentally the same
  shape of problem.
- **Live end-to-end smoke test completed** against a disposable temp repo
  (never `officercc`): implement → running → ready → view diff →
  Approve & Commit → confirmed a real commit landed in the disposable
  repo via `git log`, with the correct file content. Everything cleaned
  up afterward (temp repo deleted, `codebaseLocalPaths` setting reverted,
  test action item/DB rows removed, stray `claude` job state removed).
  Two real bugs (the `"blocked"` failure-signal bug and the
  `--allowedTools` race) were only caught by this live pass — the unit
  tests, which mock the CLI, could not have caught either, since both are
  about the real CLI's actual runtime behavior. Still not yet tried
  against `officercc` itself — that's real first-use, not a smoke test.

## Calendar view + automatic session creation

- **Motivating ask**: pull meetings from Outlook, then create sessions and a
  calendar view from them. Three design choices were made explicit up front
  (via direct questions, not assumed): (1) data source is the existing
  Outlook desktop COM export, not a new Microsoft Graph `Calendars.Read`
  integration — the user's mailbox is on-premises, so Graph would likely hit
  the same `MailboxNotEnabledForRESTAPI`-class failure the existing email
  sync already does; (2) session creation is fully automatic (a background
  job), not click-to-create; (3) the calendar view is a real day/week grid,
  not just an extended list.
- **A deliberate, explicitly-accepted exception to an existing safety
  precedent.** `outlookDesktop.ts`'s email sync (same COM automation
  mechanism) is manual-trigger-only, never polled, specifically because
  Outlook's "Object Model Guard" can show an interactive security prompt on
  first use in a session — an unattended poll could silently stall behind
  it, or surface a dialog nobody's watching. This was flagged directly
  before building the poller; the user chose to poll anyway. The mitigation
  already in place (the export script's 60s `execFile` timeout) keeps a
  stuck run from hanging the poll loop forever, but does **not** dismiss a
  visible dialog — if Outlook shows that prompt during an unattended
  `calendarImportPollMinutes` tick, a human still has to notice and approve
  it. `CALENDAR_IMPORT_ENABLED` (Settings > Calendar import) is the escape
  hatch if this turns out to be disruptive in practice.
- **Only not-yet-started meetings get auto-imported**, deliberately —
  `importUpcomingEventsThisWeek()` (`src/calendar/calendarImport.ts`) skips
  any event whose `startTime` has already passed. Importing a past event
  would set `scheduledStartAt` in the past, which `checkScheduledSessions()`
  (server.ts) treats as "due" and immediately auto-starts a recording for a
  meeting that's already over. The calendar **view** still shows the whole
  week including past meetings (via `GET /api/calendar/week`) — only the
  *import* is future-only.
- **Solo events (`attendeeCount <= 0`) never get auto-imported either** —
  personal blocks, focus time, reminders. There's no one else to have a
  "meeting" with, so a session (and the prep brief it triggers) would be
  pure noise. The calendar **view** still shows solo blocks in the grid
  (unlinked, like any not-yet-imported event) — again, only the import
  itself filters them out.
- **Canceled meetings never get auto-imported either** — found from real
  manual use, not a design guess: Outlook keeps a canceled appointment
  visible on the calendar (renamed with a "Canceled: " prefix) rather than
  removing it, so without an explicit check every cancellation was still
  spawning a session for a meeting that isn't actually happening. Confirmed
  empirically against real canceled appointments in this machine's Outlook
  (not assumed from documentation) that `MeetingStatus` is `5`
  (`olMeetingCanceled`, organizer canceled) or `7`
  (`olMeetingReceivedAndCanceled`, cancellation received) for a canceled
  item, vs. `1`/`3` for a normal one — `outlookCalendarExport.ps1` now emits
  this as `isCanceled`, threaded through `CalendarEvent` the same way as
  `endTime`. Deliberately checked via `MeetingStatus`, not by matching the
  "Canceled: " subject text, since that prefix is locale-dependent. Google
  Calendar's equivalent is `event.status === 'cancelled'`. The calendar
  **view** still shows canceled events (dimmed, struck through, via the new
  `.cal-event-canceled` CSS class) rather than hiding them outright — useful
  context, just visually distinct from something that still needs
  attention — and a canceled event that already has a session (created
  before this fix, or manually) stays clickable; the cancellation flag only
  blocks *new* auto-imports, not access to work that already exists.
- **Dedup is by `calendar_event_id`**, via the new
  `getSessionIdByCalendarEventId()` (`segmentRepository.ts`) — a plain
  `WHERE calendar_event_id = ?` query, no new index (session-creation volume
  is far too low to need one). This makes every import tick idempotent:
  reruns never double-create a session for the same event, including one a
  user already created manually via the New Session modal's existing
  calendar-shortcut picker.
- **`CalendarEvent` gained an optional `endTime` field** (`googleCalendar.ts`,
  threaded through `outlookDesktopCalendar.ts` and
  `outlookCalendarExport.ps1`'s `-StartTime`/`-EndTime` range mode) —
  needed to size event blocks in the week grid. Made optional rather than
  required specifically to avoid breaking every existing test fixture that
  constructs a `CalendarEvent` without one; the grid falls back to a default
  30-minute block when it's absent.
- **The Outlook COM export gained an explicit date-range mode**
  (`listOutlookEventsInRange(startIso, endIso)`), alongside the original
  forward-looking `listUpcomingOutlookEvents(windowMinutes)` — the week grid
  needs a range that can start *before* "now" (Monday of the current week),
  which a forward-only window can't express. `outlookCalendarExport.ps1`
  takes either `-WindowMinutes` or `-StartTime`/`-EndTime`, never both.
- **Week boundaries are Monday 00:00 through the following Monday 00:00**,
  local time (`getCurrentWeekRange()`) — Sunday is the last day of its week,
  not the first day of the next one.
- Reuses existing infrastructure rather than duplicating it:
  `classifyMeetingType()` for the auto-created session's meeting type,
  `runPrep()` (the exact function `/api/session/prepare` already calls) so
  an imported session gets a real prep brief before the meeting starts, and
  `checkScheduledSessions()` (unchanged) for the actual auto-start-recording
  behavior once `scheduledStartAt` arrives.
- **A real CSS bug caught by the Playwright e2e spec, not code review**:
  `#calendarEmptyState { display: flex; ... }` silently overrode the
  `hidden` attribute — an ID selector (specificity 1,0,0) beats the
  browser's default `[hidden] { display: none }` UA rule (specificity
  0,1,0) even with no `!important` involved, so setting `.hidden = true`
  in JS had no visible effect. Every other hidden-toggled element in this
  file already carries an explicit `#id[hidden] { display: none; }` override
  (e.g. `#settingsOverlay[hidden]`) — this one was missed. Fixed the same
  way. A reminder that any new element toggled via the `hidden` property/
  attribute needs that override paired with its `display: ...` rule, not
  just the toggle logic.
- **`tests/e2e/calendar.spec.ts` is this suite's first use of
  `page.route()` network mocking**, deliberately breaking with every other
  spec's "hit the real backend" convention — `GET /api/calendar/week`
  shells out to the same Outlook COM automation as the import poller, so
  letting it run for real during a test would make results depend on
  whatever's actually in the tester's live Outlook calendar right now, and
  carries the same Object Model Guard prompt risk noted above. Mocking just
  that one route keeps the spec's assertions about grid rendering and
  click-through-to-session behavior fully deterministic and safe to run
  anywhere, while still driving everything else (session lookup, `#mainTitle`
  update) through the real running server.
- **A second real bug, found through actual manual use against a real
  Outlook calendar (not a test)**: the "Sync now" status checked the
  in-progress state exactly once, on a single fixed 1.5s `setTimeout`, then
  never looked again — copied from the pre-existing "Sync via Outlook
  desktop" Settings button, which has the same latent issue. Against a real
  calendar with many appointments, the actual COM export routinely takes
  longer than 1.5s, so the UI got stuck showing "Syncing… approve the
  Outlook prompt if one appears" forever even after the sync had genuinely
  finished (confirmed by the calendar grid itself already showing the
  freshly-imported events). Fixed by making `refreshCalendarImportStatus()`
  self-schedule every 2s for as long as `inProgress` stays true, called both
  right after clicking "Sync now" and whenever the calendar view opens (in
  case a sync — manual or the background poller's — is already running).
  Guarded by a regression test in `calendar.spec.ts` that mocks a
  status transition from in-progress to done and asserts the UI text
  actually follows it, rather than staying stuck.
- **A third real bug, again found through actual manual use, this time
  pre-dating the calendar feature entirely**: `setMainHeader()` computed
  "is this session recording?" as `!session.endedAt` — true for *any*
  session that merely exists and hasn't ended, not just one that's actually
  live. Every session row gets `started_at` set at creation time
  (`createSession`'s `INSERT ... datetime('now')`), regardless of whether
  real audio capture has begun — true for `/api/session/prepare` sessions
  even before the calendar feature existed, but the calendar's bulk
  auto-import made it dramatically more visible (opening any of the many
  now-existing "ready — not yet started" sessions showed a bright red
  "Recording…" header that was simply false). The sidebar cards already had
  the correct signal (`s.id === liveSessionId`, via `sessionMetaLabel()`) —
  `setMainHeader()` just wasn't using it. Fixed by reusing
  `sessionMetaLabel()` instead of re-deriving the state incorrectly.
  While in there, also fixed a related gap in the `session-start` WS
  handler: it already refreshed the *sidebar* when a session auto-started
  with no client-side driver (the schedule poller), but never refreshed the
  *main panel* header if that auto-started session happened to be the one
  already open — mirrored the fix `session-stop`'s handler already used
  (`refreshSessions().then(() => { if (msg.sessionId === activeSessionId) openSession(msg.sessionId); })`).
- **Found and fixed a pre-existing, unrelated stale e2e test while
  re-verifying the above**: `tests/e2e/scheduledSession.spec.ts` clicked
  `#workTypeBtn`, a button removed by the earlier "Speako work-only"
  refactor (commit `732ac86`) that deleted the personal/work type picker —
  meaning both of that file's tests had been failing (timing out) ever
  since, silently, since nothing in this session's or prior sessions' test
  runs happened to include `test:e2e` until now. Fixed by deleting the two
  dead `.click('#workTypeBtn')` calls; both tests pass again, including the
  real auto-start-at-scheduled-time test, which also served as a live
  regression check for the `setMainHeader`/`session-start` fix above.

## Scheduled auto-stop (mirrors the existing auto-start)

- **Motivating ask**: a calendar-imported session should not just auto-start
  at the meeting's start time (already existed via `scheduledStartAt` +
  `checkScheduledSessions()`) but also auto-stop at the meeting's end time —
  previously there was no such mechanism at all; a calendar-started
  recording would run forever until someone manually clicked "Stop".
- **New `scheduled_end_at` column on `sessions`**, set from the calendar
  event's `endTime` at import time
  (`src/calendar/calendarImport.ts`'s `createSession(...)` call). Deliberately
  a plain column (no index) — unlike `scheduled_start_at`, which
  `getDueScheduledSessions()` scans across *every* not-yet-started session,
  `scheduled_end_at` is only ever looked up for the single session actually
  recording right now (`isScheduledEndDue(sessionId, nowIso)`, a `WHERE id = ?`
  point lookup), so a scan-avoiding index would add write overhead for no
  read benefit.
- **`checkScheduledEndSessions()` mirrors `checkScheduledSessions()`
  exactly**, just for the other end: same 20s timer (added to the existing
  `scheduleTimer` tick rather than a new interval), same
  onStop/broadcast/`currentSessionId` sequence `POST /api/session/stop`
  already uses. Only ever checks the one session Speako considers "live"
  (`this.currentSessionId`) — a session that hasn't started recording yet,
  or already ended some other way, has nothing to auto-stop.
- **`scheduledEndAt` survives `Session.start()`'s clearing of
  `scheduledStartAt`** — confirmed by reading `session.ts`, not assumed:
  `start()` calls `setScheduledStartAt(id, null)` once recording actually
  begins (so the start-poller doesn't re-trigger it), but never touches
  `scheduled_end_at`, so the auto-stop time is still there when the
  end-poller later checks it.
- **A deliberate footgun guard**: `PATCH /api/sessions/:id/schedule` (the
  manual "Schedule recording start" UI, which has no field for an end time)
  now always clears `scheduled_end_at` to null whenever it's called,
  regardless of what `scheduledStartAt` is set to. Without this, canceling
  or changing a calendar-imported session's start time through the manual
  UI would leave its *original* meeting-end time behind — and if that time
  was already in the past, the very next 20s poll tick would immediately
  auto-stop a freshly (and deliberately) manually-started recording that
  has nothing to do with the original calendar schedule.

## Resuming a stopped session

- **Motivating ask**: the user needs to be able to manually (re)start a
  session's recording "if needed" — surfaced directly by a real
  incident: several calendar-imported sessions had been auto-started and
  immediately auto-stopped by mistake (0 segments, before their real
  meetings had even happened) while the dev server was left running during
  testing, and there was no way to get them back into a recordable state
  short of deleting and re-importing.
- **`Session.start()`'s resume branch only cleared `scheduled_start_at`,
  never `ended_at`** — so calling `POST /api/session/start` again with the
  same `sessionId` on an already-ended session would start capturing audio
  under a row every other part of the app still considered "stopped"
  (`sessionMetaLabel()`'s ended branch, the sidebar's `notYetStarted`
  check, etc. all key off `ended_at`). New `resumeSession()`
  (`segmentRepository.ts`) clears it; `Session.start()`'s resume path now
  calls it alongside the existing `setScheduledStartAt(id, null)`.
  Deliberately harmless to call on a session that was never actually
  ended (`ended_at` is already null, so it's a no-op) — no need to branch
  on which case this is.
- **A "Resume recording" button now shows for any ended `work`/`meeting`
  session**, reusing the exact same `.session-start-recording` click
  handler and `POST /api/session/start` call the "Start recording" button
  already uses (same class, so no new wiring needed — only the label and a
  distinct muted color differ). Deliberately ungated on segment count,
  summary, or diarization status — the user asked for the general
  capability "if needed," not a narrower one scoped just to the 0-segment
  artifact case that prompted it. Existing transcript/summary/etc. rows are
  untouched by resuming; new segments simply keep appending to the same
  session.

## In-session Start/Pause/Resume/Stop controls

- **Motivating ask**: add Start/Pause/Resume/Stop directly in the open
  session's main panel, not just the sidebar (Start/Resume) and the
  sidebar-header's global Stop button. Pause didn't exist anywhere before
  this — investigated feasibility first (a dedicated research pass over
  `soxCapture.ts`/`streamManager.ts`/`session.ts`) rather than assuming it
  was a small UI-only addition, since genuinely new audio-pipeline
  capability was involved, not just wiring up an existing action.
- **`SoxCapture.start()`/`.stop()` are safe to call repeatedly on the same
  instance** — confirmed by reading the actual implementation, not assumed.
  `stop()` just kills the child process and nulls the reference; `start()`
  respawns fresh and re-registers `this.proc.stdout.on('data', ...)` etc. on
  the *new* process object — but the *external* listeners a caller attaches
  via `capture.on('data', ...)` live on the `SoxCapture` `EventEmitter`
  itself, not the process, so they survive a stop/start cycle untouched.
  This meant `Session.pause()`/`resumeRecording()` never needed to
  re-wire any listeners or construct a new `SoxCapture` instance — a real
  simplification found only by reading the code, not by design intuition.
- **`StreamManager` already had a "swap the underlying Google stream
  without losing session state" mechanism** (`restart()`, used for the
  periodic `streamRestartSeconds` reconnect) — but it wasn't a drop-in fit
  for a user-triggered pause, which can last arbitrarily long:
  `restart()` buffers incoming audio in memory during the swap
  (`pendingChunks`) and assumes an near-instant handoff (a 5s force-flush
  safety valve). A pause of several minutes would grow that buffer
  unboundedly and eventually flush a burst of stale audio into a
  freshly-opened stream. So `pause()`/`resume()` are new, separate methods:
  `pause()` closes the current call outright (no buffering) and cancels the
  restart timer; `writeAudio()` drops rather than buffers anything written
  while paused (defensive — nothing should actually call it, since
  `Session.pause()` also stops feeding audio in via `capture.stop()`).
- **Paused time doesn't count on the recording's audio-time axis** —
  `resume()` sets `streamOffsetMs = totalMsWritten` as it stands the moment
  resume happens (nothing accrued while paused). Segment timestamps stay
  continuous across the gap rather than jumping by however long the pause
  lasted in wall-clock time — deliberately simpler than trying to represent
  "a gap occurred" in the timestamp axis itself; the transcript just reads
  as if the paused stretch never happened, audio-time-wise.
- **`paused` is tracked as its own flag, separate from `currentSessionId`
  being set, at every layer** (`StreamManager.paused`, `Session.paused`,
  `InterfaceServer.paused`) — pausing must never make `POST
  /api/session/start` think nothing is recording (it would try to start a
  second session) or make `POST /api/session/stop` think there's nothing to
  stop. `InterfaceServer.paused` resets to `false` on every real
  start (`setSession()`) and stop (`POST /api/session/stop`), so it can
  never leak stale into an unrelated later session.
- **`Session.stop()` works correctly even when called while paused** —
  `capture.stop()` is a no-op if already stopped (the pause already killed
  the process), and `streamManager.stop()` tolerates `this.call` already
  being `null` and `this.restartTimer` already cleared (both already true
  after `pause()`). Confirmed by reading the exact guard conditions in both
  methods, not assumed safe.
- **Frontend**: a new `#recordingControls` cluster (Start/Pause/Resume/Stop)
  in `#mainHeaderActions`, scoped to whichever session is open in the main
  panel — distinct from the sidebar's per-card Start/Resume buttons and the
  sidebar-header's global Stop button, which still exist unchanged.
  `updateRecordingControls()` mirrors the sidebar's
  `notYetStarted`/`canResume` logic but for "the one session I'm looking at
  right now." A new `.paused` state on `#mainMeta` (static muted dot, no
  pulse) is visually distinct from `.recording` (pulsing red dot).
- **Not yet tested against real hardware** — this touches the actual SoX
  child process and live Google Speech-to-Text stream, which the sandboxed
  dev/test environment here can't exercise end-to-end (no real microphone
  pipeline). Verified via: (a) new unit tests for `StreamManager.pause()`/
  `resume()` (timestamp continuity, dropped-not-buffered audio during
  pause, no-op-when-already-stopped), (b) reading `SoxCapture`/`Session`'s
  exact guard logic rather than assuming correctness, and (c) the existing
  real-schedule-based e2e test (`scheduledSession.spec.ts`) still passing,
  which exercises the same `Session.start()` code path pause/resume sits
  next to. A first real run against actual audio hardware should happen
  before relying on this for a real meeting.

## Outlook/Google meeting metadata on the session

- **Motivating ask**: carry the actual Outlook (or Google Calendar) meeting
  details — location, organizer, attendees, description — onto the session
  itself, not just the title, when that session was created from a
  calendar event (auto-import, or the New Session modal's calendar picker).
- **Verified the relevant Outlook COM properties directly against this
  machine's real calendar before writing any code** — `.Location` and
  `.Organizer` are plain display strings; `.Recipients` is enumerable with
  a `.Name` (display name) per recipient, confirmed on real appointments
  with up to 27 attendees. `.Recipients[].Address` is an Exchange DN
  (`/o=ExchangeLabs/ou=.../cn=Recipients/cn=...`), **not** a usable SMTP
  address — resolving a real email per recipient would need
  `AddressEntry.GetExchangeUser()`, which is slow across dozens of
  attendees and unnecessary here, so `attendees` is just display names.
- **`CalendarEvent` gained three new optional fields** (`location`,
  `organizer`, `attendees: string[]`) — same optionality rationale as
  `endTime`/`isCanceled` before them: existing test fixtures and
  `classifyMeetingType()` don't need them, so they're additive, not
  breaking. Populated on both the Outlook path
  (`outlookCalendarExport.ps1` → `outlookDesktopCalendar.ts`) and the
  Google Calendar path (`event.location`/`event.organizer`/`event.attendees`
  from the v3 Events resource).
- **New `calendar_meeting_info` TEXT column on `sessions`**, storing a
  small JSON blob (`CalendarMeetingInfo`: location/organizer/attendees/
  description) — deliberately a storage-owned interface in
  `segmentRepository.ts` rather than importing `CalendarEvent` from
  `integrations/googleCalendar.ts`, to avoid `storage/` depending on
  `integrations/` (the wrong direction; `calendarImport.ts` already depends
  on both, which is the correct direction). Both `getSession()` and
  `listSessions()` parse it back out, same JSON-column pattern as
  `active_tools`/`active_features`.
- **Threaded through both places a session can be "created from an Outlook
  meeting,"** not just the obvious one: (1) the calendar auto-import
  (`calendarImport.ts`'s new `toCalendarMeetingInfo()` helper), and (2) the
  New Session modal's manual calendar-event picker — which already had the
  *full* `CalendarEvent` object client-side the moment the user clicks one
  (`loadCalendarShortcuts()`), but was previously discarding everything
  except the bare `id`. `POST /api/session/prepare` gained four new
  optional body fields (`calendarLocation`/`calendarOrganizer`/
  `calendarAttendees`/`calendarDescription`) to carry it the rest of the
  way.
- **Displayed in the Prep Brief tab**, above the AI-synthesized brief and
  the user-notes box — a new `#calendarMeetingInfoBox`, rendered from the
  already-cached `sessions` array (`renderCalendarMeetingInfo()`), not a
  separate fetch. Deliberately independent of whether the prep brief itself
  succeeded/is still pending: a calendar-imported session has this
  metadata the moment it's created, regardless of prep's outcome.

## Live app-logs viewer

- **Motivating ask**: a screen to consult the app's own logs live, without
  tailing the terminal — useful for diagnosing things like the earlier
  stuck-"Syncing…" and ghost-session bugs from inside the app itself.
- **No logging library was in use anywhere** (checked `package.json` and
  every module) — just ~90 scattered raw `console.log`/`warn`/`error`
  calls. Rather than introduce winston/pino and touch every call site, a
  small `src/logging/logStore.ts` module monkey-patches `console.log`/
  `info`/`warn`/`error` once (idempotent `patched` guard) so every existing
  call site keeps working unmodified, still prints to the real
  stdout/stderr, and now *also* lands in an in-memory ring buffer (last 500
  entries) and fans out to subscribers via a plain listener `Set`.
  `patchConsole()` is called as the first line of `main()` in `src/index.ts`
  — anything logged at module-import time (before `main()` runs) is missed,
  which is an acceptable gap rather than restructuring the entry point.
- **No new WebSocket infrastructure needed** — `InterfaceServer` already
  had a single shared `broadcast()` used for every other live-update type
  (`segment`, `waveform`, `session-start`, …), so a log line is just another
  `broadcastLogLine()` wrapper subscribed once via `onLogEntry()` right
  after `this.wss` is constructed, sending `{ type: 'log-line', entry }` to
  every connected client. `GET /api/logs` returns the current buffer so the
  panel has history immediately on open, not just lines logged after.
- **Frontend**: a new `#logsOverlay`/`#logsModal`, following the exact same
  overlay/modal convention as Settings/Insights/Calendar (same CSS classes,
  same open/close/backdrop-click wiring). A level filter (all / warn+error /
  error-only), an auto-scroll toggle, and a client-side "Clear" (clears the
  view only — the server's buffer and the next `GET /api/logs` are
  untouched, by design, since this is a viewer, not a truncation control).
  Log lines are buffered client-side too (capped at 1000) independent of
  the active filter, so switching the filter re-renders from what's already
  arrived instead of losing anything received while a narrower filter was
  selected.

## Manually adding action items

- **Motivating ask**: let the user add an action item by hand, not just rely
  on what the AI summary extracts from the transcript.
- **The real risk here wasn't the UI, it was the existing `DELETE FROM
  action_items WHERE session_id = ?` inside `saveSummaryAndActionItems`** —
  regenerating the AI summary already wiped and replaced every action item
  for a session unconditionally. A manually-added item would have silently
  disappeared the next time someone clicked "Generate summary". Fixed by
  giving manual items their own `confidence: 'manual'` value (alongside the
  existing `'explicit'`/`'inferred'`) and scoping that delete to
  `confidence != 'manual'` — AI regeneration now only ever touches what the
  AI itself produced.
- **New endpoints**: `POST /api/sessions/:id/action-items` (owner/dueDate
  optional, description required) and `DELETE /api/action-items/:id`,
  mirroring the existing `PATCH /api/action-items/:id` status-toggle route.
  Broadcasts `action-item-added`/`action-item-deleted` over the existing
  WebSocket so a second open tab/window stays in sync — the tab that
  actually submitted already re-renders itself from the fetch response, so
  the WS handler only applies the change if it isn't already reflected.
- **Frontend**: an always-visible "+ Add action item" affordance in the
  Action Items tab (previously that tab rendered nothing but an empty-state
  message until a summary existed) that reveals an inline form; a delete
  (×) button per row, gated behind a `confirm()` like session deletion.
  Manual items get their own badge color, distinct from explicit/inferred.

## Action item types (one-click follow-through per kind of task)

- **Motivating ask**: classify each action item by what kind of follow-up
  it actually is — write an email, a code change, update a Jira ticket,
  update a Confluence page, a reminder, a to-do, plus two more suggested
  and accepted during scoping: schedule a follow-up meeting, send a Teams
  message — and offer a one-click action suited to that type.
- **Scope decision (asked explicitly, since it has real external-system
  risk)**: "categorize + real one-click actions where safe" — never
  auto-create a Jira ticket, auto-update a Confluence page, or auto-send an
  email. Every action opens a prefilled deep link or system compose window
  that the user still reviews and submits themselves. Full automation
  (real Jira REST writes via the existing MCP client's write tools, real
  Graph `Mail.Send`) was explicitly declined for this round.
- **New `action_items.type` column** (`ActionItemType` in
  `summaryRepository.ts`), migrated via the standard `ADD COLUMN ... DEFAULT
  'general'` pattern — every pre-existing row becomes 'general' rather than
  guessing a type from its free-text description.
- **"Implement with Claude Code" is now just the `code_change` type's
  action**, instead of appearing unconditionally on every action item —
  generalizes the existing side-table-per-follow-up pattern
  (`code_change_requests`) rather than replacing it.
- **The AI extraction path (`summarize.ts`) also classifies `type`** now,
  not just manually-added items — otherwise every AI-extracted action item
  would default to 'general' and the "Implement with Claude Code" button
  would have silently stopped appearing for exactly the items it used to
  show up for. Defensively coerced to `'general'` in code even though the
  schema's `enum` should already guarantee a valid value — never trust a
  model response as blindly as a schema-validated one.
- **Real pre-existing bug found and fixed along the way**: `PATCH
  /api/action-items/:id` unconditionally reset `status` to `'open'` on
  *every* call, even one that only meant to change something else — so the
  first type-change PATCH would have silently un-done a "done" checkbox.
  Fixed to only touch `status`/`type` when actually present in the body.
- **Per-type actions, all client-side, no new server dependencies**:
  - `email` → `mailto:?subject=...`
  - `jira` / `confluence` → copies the description to the clipboard and
    opens the configured `jiraUrl`/`confluenceUrl` (already in Settings).
    Deliberately *not* a guessed "create issue/page" URL — there's no
    single URL shape that reliably works across both Jira/Confluence
    Server-DC and Cloud without knowing a project key or space key, and a
    broken deep link is worse than an honest "copy + open".
  - `schedule_meeting` → Google Calendar's documented `render?action=
    TEMPLATE` prefill link (works with no auth/config).
  - `teams_message` → Teams' `l/chat/0/0?message=...` deep link.
  - `reminder` → schedules a browser `Notification` at 9am local time on
    the item's due date (client-only — fires only while the tab stays
    open; there's no OS-level reminder integration in this app).
  - `todo`/`general` → categorization only, no action button.

## Real Jira/Confluence execution (upgrading from deep links)

- **Scope change from the previous round**: the earlier "action item types"
  feature deliberately kept Jira/Confluence as "copy description + open the
  base URL" rather than a real write, to avoid guessing wrong against a
  real ticket tracker. Asked explicitly this round, scoped precisely:
  **only Jira and Confluence become real writes**; email and Teams stay as
  drafts (mailto:/deep link, never auto-sent); "Implement with Claude Code"
  and schedule-meeting are unchanged.
- **Verified the exact tool parameter names against `mcp-atlassian`'s own
  docs before writing any code** (same methodology as the Outlook COM
  properties earlier in this project) — `jira_create_issue`
  (`project_key`/`issue_type`/`summary`/`description`), `jira_update_issue`
  (`issue_key` + optional `transition` name/id + `comment` — no separate
  transition-id lookup call needed, the tool accepts a plain status name),
  `confluence_create_page` (`space_key`/`title`/`content`/`parent_id`),
  `confluence_update_page` (`page_id`/`title`/`content`). Never guessed a
  parameter name against a real destructive external call.
- **New `src/integrations/jiraMcp.ts` / `confluenceMcp.ts` write functions**
  (`createJiraIssue`, `updateJiraIssue`, `createConfluencePage`,
  `updateConfluencePage`) sit alongside the pre-existing read-only
  `searchJira`/`searchConfluence` in the same files — same shared MCP
  client (`atlassianMcp.ts`), explicitly documented as only reachable from
  the new one-item-at-a-time dialog, never from the fact-check/live-Q&A
  paths that also use this client.
- **New `action_items.external_ref` column** (JSON: tool, action taken,
  the resulting issue key/page id, its URL, timestamp) — set only after a
  real create/update actually succeeds, so the Action Items tab can show
  "PROJ-42 created ↗" as a real link instead of leaving the user to wonder
  whether clicking the button did anything.
- **Small dialog instead of Settings-wide defaults** (explicit choice —
  asked, since neither a project key nor a space key exists anywhere on an
  action item today): clicking "Create / update Jira" opens a dialog that
  auto-detects an existing issue key already named in the description
  (reusing the same `[A-Z][A-Z0-9]+-\d+` pattern `jiraMcp.ts`'s read path
  already used for fact-checking) and defaults to "update" mode
  pre-filled with it; otherwise defaults to "create" with empty
  project/issue-type fields. Confluence has no equivalent detectable
  pattern, so it always defaults to "create." Either dialog lets the user
  switch modes and edit every field before submitting — nothing is created
  or updated without that explicit per-item confirmation.
- **Server routes return 502 on failure** (`POST /api/action-items/:id/jira`
  and `/confluence`) rather than 500 — the failure is an upstream Jira/
  Confluence/MCP problem the app is just relaying, not a bug in Speako
  itself.

## AI-drafted Jira/Confluence dialog fields

- **Motivating question**: the previous round's Jira/Confluence dialog left
  every field (besides an auto-detected issue key) blank or a verbatim copy
  of the raw meeting-note sentence — asked directly whether AI was involved
  in interpreting the description, and it wasn't. This adds that step.
- **New `src/summarization/actionItemDrafts.ts`**: one on-demand Gemini call
  per dialog open (`suggestJiraFields`/`suggestConfluenceFields`), same
  cost-tiering convention as `chapters.ts` — mechanical extraction from a
  short, already-in-hand action item description, so it's routed to
  `config.geminiFastModel` with `thinkingBudget: 1`. Turns a raw sentence
  like "update JIRA:ETICK-9253 status to in progress" into a proper issue
  type, a real title, an expanded description, and — specifically for the
  "this is about an existing issue" case — a suggested status transition
  name and comment.
- **Deliberately never decides create-vs-update mode itself** — that stays
  the deterministic issue-key regex (`jiraMcp.ts`'s pattern, reused
  client-side) plus the user's own mode toggle. The AI only drafts the
  content of whichever fields are on screen; it doesn't get a vote on the
  structural create/update decision.
- **New `GET /api/action-items/:id/jira/suggest` and `/confluence/suggest`**
  — read-only, never itself creates/updates anything. Fired once when the
  dialog opens; fields the user has already started typing into are left
  alone once the suggestion arrives (tracked via a simple per-field `dirty`
  flag set on first `input` event) — the AI never overwrites something
  actively being edited. A small "Asking AI for suggestions…" status line
  shows while it's in flight, and a plain-language fallback message if it
  fails (Gemini not configured, upstream error) — the dialog is always
  still fully usable manually either way.
- Every field, AI-suggested or not, is still just a starting point the user
  reviews and edits before clicking submit — nothing is created or updated
  until that explicit confirmation, same as before this change.

## Extending AI drafting to email/Teams/schedule-meeting

- Asked directly ("what about the other action types?") after adding
  AI-drafted Jira/Confluence fields — extended the same drafting step to
  the three remaining deep-link types: `email` (subject + body →
  `mailto:`), `teams_message` (a short chat-toned message, not an email —
  deliberately prompted differently), and `schedule_meeting` (event title +
  details → Google Calendar's prefill link). `reminder`/`todo`/`general`
  are unchanged — a reminder's whole content already is the raw
  description, there's nothing to draft; `code_change` already gets far
  deeper AI involvement via the full Claude Code CLI flow.
- These three stay deep-link-only (never sent/posted/created by Speako
  itself — same scope line as before) — only the *content* going into the
  link is now AI-drafted instead of the verbatim sentence.
- Reused the exact `draftThenOpen()` pattern once instead of three near-
  duplicates: fetch the suggestion, build the URL from it (falling back to
  the raw description on any failure — a Gemini hiccup never blocks the
  deep link outright), then open it. Button shows "Drafting…" while in
  flight.
- teams_message/schedule_meeting still need the same popup-blocker-safe
  "open a blank tab before the first await" trick already used for Jira/
  Confluence (`window.open()` after an `await` gets silently dropped by
  popup blockers); mailto navigation via `location.href` has no such
  restriction, so email skips it.

## "No transcript during/after recording" — investigated, root cause not in this app's code

- **Reported symptom**: a real recording produced an entirely empty
  transcript, live and after stopping (0 segments) — the console showed
  repeated `[transcription] error: 5 NOT_FOUND: Requested entity was not
  found.` from Google Speech-to-Text.
- **Ruled out, empirically, not by inspection**: re-ran the exact same
  `speechClient._streamingRecognize()` call the app makes — same recognizer
  path (`projects/<id>/locations/us/recognizers/_`), same `chirp_3` model,
  same 2-channel `SEPARATE_RECOGNITION_PER_CHANNEL` config used for real
  meetings — directly against the real configured GCP project/credentials.
  It succeeded cleanly (both channels returned results). So: not a stale
  `.env`, not a broken credential, not a chirp_3/multi-channel
  incompatibility, not a wrong region — all confirmed live, not assumed.
  Conclusion: the `NOT_FOUND` was a **transient Google Cloud–side issue** at
  that specific moment, not a standing misconfiguration in this app.
- **Real gap found and fixed regardless of root cause**: `Session`'s
  `streamManager.on('error', ...)` handler (`session.ts`) only ever
  `console.error`'d — a dead/failed transcription stream left the user
  staring at a silently empty transcript with **zero indication anything
  was wrong**, for the rest of the recording. Now also calls the new
  `InterfaceServer.broadcastTranscriptionError(sessionId, message)`,
  broadcasting `{ type: 'transcription-error', sessionId, message }`. The
  frontend shows this as a red banner above the transcript
  (`#transcriptionErrorBanner`) — cleared automatically the moment a real
  segment successfully renders again (proof the stream recovered), or when
  a different session is opened. Recording itself is unaffected either
  way — this only makes an already-broken stream visible instead of silent.
- Recommends checking the new in-app Logs panel (built earlier this
  session) any time this banner appears, since the full error
  (`err.details`/`err.metadata`/`err.code`) is still logged there via the
  same `console.error` calls.

## SoX's normal output was mislabeled as an error

- **Found from a real Logs-panel screenshot**: the user's "I see errors in
  the log files" turned out to include SoX's completely routine startup
  banner (`Input File`, `Channels: N`, the `In:/Out:` progress meter) —
  tagged `error` in the Logs panel and in raw console output.
- **Root cause**: `session.ts`'s `capture.on('log', ...)` handler routed
  *everything* SoX writes to stderr through `console.error` — but SoX
  writes its normal informational banner/progress meter to stderr as a
  matter of course, not just actual problems. Every single recording's
  startup was misclassified as an error, which is exactly the kind of
  false alarm that makes a real error (like the `[transcription] error:`
  `NOT_FOUND` from earlier) harder to spot in the noise.
- **Fixed**: routine SoX output now goes through `console.log`, not
  `console.error`. Genuine capture failures (SoX exiting non-zero, the
  binary failing to spawn) are unaffected — those already came through a
  separate `capture.on('error', ...)` handler that was already correctly
  `console.error`.
- `channelCount = config.systemDevice ? 2 : 1` (`soxCapture.ts:41`) — a
  single-channel capture (`Channels: 1` in the banner) is expected,
  correct behavior when `SYSTEM_AUDIO_DEVICE` isn't configured, not a bug.
  Speaker separation ("You"/"Others") requires that second device.

## Optional prep at session creation ("Just save", run prep later)

- **Motivating ask**: creating a session manually always ran prep
  immediately (`POST /api/session/prepare` unconditionally called
  `runPrep()`) — no way to just create the session and decide about prep
  later.
- **New `skipPrep` flag on `POST /api/session/prepare`**: when true, the
  session is created with `prepStatus: 'none'` (already a valid value —
  distinct from `'pending'`) and `runPrep()` is never called. The New
  Session modal now has two buttons: "Prepare session" (unchanged) and
  "Just save" (new, `#saveOnlyBtn`) sitting next to it.
- **New `POST /api/sessions/:id/prep`**: triggers prep later for a session
  whose `prepStatus` is `'none'` or `'failed'` — reuses the
  `meetingType`/`calendarEventId`/`activeTools` already stored on the row
  from creation. Returns 409 if prep is already `'pending'` (no double-run).
  No fresh `userNotes` input at this point — that only ever existed in the
  New Session modal at creation time.
- **Frontend**: a "Run prep now" button in the Prep Brief tab
  (`#runPrepBtn`), shown only when `prepStatus` is `'none'`/`'failed'`
  (relabeled "Retry prep" for the latter) — hidden once prep is
  running/done. New `prep-started` WS broadcast (alongside the existing
  `prep-ready`) so the button's state updates live without a manual
  refresh.
- **Found and fixed three separate stale e2e tests while touching this
  area** — `tests/e2e/newSession.spec.ts` and `tests/e2e/liveSession.spec.ts`
  both still clicked `#workTypeBtn`/`#personalTypeBtn`/`#startBtn`, buttons
  removed by the "Speako is work-only" refactor (commit `732ac86`) months
  ago; neither test had been updated since and both were silently broken
  (confirmed by actually running them, not by inspection — matches the
  `scheduledSession.spec.ts` staleness found earlier this session, now a
  third confirmed instance of the same class of bug). Fixed both to match
  the current always-visible work-prep-box flow, and rewrote
  `liveSession.spec.ts` to create its session via the new "Just save" button
  (this test exercises the audio pipeline, not prep, so skipping prep
  entirely is the more correct choice, not just a compatibility fix).

## Prep no longer marked "failed" when there was just nothing to prepare

- **Motivating report**: a session with no calendar event, no user notes,
  and configured tools that turned up nothing showed a `failed` prep
  badge — confirmed via the database (a real `prep_briefs` row existed,
  with `sources_queried: []` and the honest fallback text
  `synthesizeBrief.ts` already produces for exactly this case: "No prep
  context was found for this <type> session."). Nothing had actually
  thrown or errored.
- **Root cause**: `PrepService.ts`'s `runPrep()` conflated two different
  things under one `succeeded` flag — "the prep run completed without
  throwing" and "sources.length > 0 || hasUserNotes" — and used the second,
  weaker condition to decide `'ready'` vs `'failed'`. A completed run with
  nothing to prepare from got the same status as a genuine crash
  (network/API failure in the `catch` block).
- **Fixed**: reaching the end of the `try` block (a real brief — however
  thin — got synthesized and persisted) now always sets `'ready'`.
  `'failed'` is reserved exclusively for the `catch` block — an actual
  thrown exception, where no usable brief exists at all. The "Run prep
  now"/"Retry prep" button added earlier this session still only shows for
  `'none'`/`'failed'`, so a genuinely-failed run is still easy to retry —
  it just no longer misrepresents an empty-but-successful run as an error.
- Also found and cleaned up: three test-artifact sessions had leaked into
  the *real* `data/speako.db` from earlier manual server testing (a server
  instance started without pointing `DB_PATH` at the isolated e2e
  database) — deleted via the same `deleteSession`-mirroring transaction
  pattern used for cleanup earlier in this project.

## "Chat with AI" as a third option in "+ New session"

- **Motivating ask**: a session could always just be a chat with the AI
  (voice or typed) — that flow already existed (the mic icon in the
  sidebar header, `startVoice('chat')`), but it wasn't reachable from the
  "+ New session" modal, so it wasn't discoverable alongside "Prepare
  session"/"Just save".
- **No new session-creation logic** — added `#chatWithAiBtn` as a third
  button in the same action row, which just closes the modal and calls the
  exact same `startVoice('chat')` already used by the mic icon (creates a
  `session_kind: 'chat'` row exactly as before, shows up in the sidebar's
  Chat tab). Skips every meeting-specific field (name, meeting type, tools,
  schedule) entirely, since none of that applies to a chat session.

## "Chat with AI" now carries the modal's session settings through

- **Follow-up to the previous round**: the new "Chat with AI" button just
  called `startVoice('chat')` with nothing else — silently ignoring
  whatever name/language/tools were set in the same modal, identical to
  the pre-existing mic-icon behavior (always the global `config.
  voiceToolKeys`/`config.languageCodes` defaults). Clarified: the whole
  point was for those settings to actually apply.
- **Threaded through**: `startVoice(mode, sourceSessionId, chatOptions)`
  now optionally sends `{ name, languageCode, activeTools }` in the
  `voice-start` WS message — only when called from the New Session modal's
  "Chat with AI" button, which reads them from the same
  `nameInput`/`languageSelect`/`newSessionToolsChecklist` used for meeting
  sessions. The sidebar mic icon still calls `startVoice('chat')` with no
  options, so its behavior is completely unchanged — global defaults, as
  before this existed.
- **`ActiveTools` semantics kept consistent with meeting sessions** —
  `chatOptions.activeTools` is the *raw* selection (an explicit array,
  possibly empty — "no tools" is a real choice) stored as-is on the
  session row; it's filtered down to `VOICE_TOOL_KEYS` (a deliberately
  narrower set than meeting sessions get — no email/teams/webSearch) and
  "is actually configured" right before being handed to
  `LiveVoiceSession`, mirroring exactly how the pre-existing global-default
  path already worked. The stored row always keeps the unfiltered choice,
  same principle as meeting sessions' `activeTools` column.
- **"Heavy features" deliberately excluded** — chat sessions have no
  transcript/trigger-detection/meeting-state pipeline for those toggles
  (fact-checking, sentiment, etc.) to gate anything on; sending them would
  be a no-op with no consumer, so the modal's features checklist isn't
  threaded through to chat at all.

## New Session modal simplified to one "Save" button

- **Follow-up to the previous two rounds**: collapsed "Prepare session" /
  "Just save" / "Chat with AI" down to a single button. Prep is now *never*
  triggered at creation time, period — it only ever runs later via the Prep
  Brief tab's "Run prep now" (built two rounds ago). "Chat with AI" moved
  into the meeting-type dropdown (`#meetingTypeSelect`) as its own option,
  since it isn't really "a kind of meeting" so much as a different mode
  entirely.
- **The dropdown value drives what the single button does**: selecting
  "Chat with AI" hides `#meetingOnlyFields` (workflow preview, calendar
  shortcuts, user notes, schedule field — none of which mean anything for
  a live chat) and relabels the button "Start chat"; any real meeting type
  keeps that section visible and the button reads "Save". The tools
  checklist stays visible either way — tools apply to both. Clicking
  "Start chat" calls the exact same `startVoice('chat', ...)` path from
  the previous round (carrying name/language/tools through); clicking
  "Save" always creates with `skipPrep: true` now — there's no other option
  left to send `false`.
- **`'chat'` is a UI-only value** — never sent as a `meetingType` to
  `POST /api/session/prepare` (that route still only knows the real
  `MeetingType` union); selecting it routes to `startChatFromModal()`
  instead of `createSessionFromModal()` entirely, bypassing that endpoint.
- Fixed two more e2e tests broken by removing `#prepareBtn`
  (`scheduledSession.spec.ts`, both scheduling tests) — same stale-button
  class of bug as the three fixed in earlier rounds, caught the same way
  (by actually running the suite, not just typechecking).
- Ran into a genuine (unrelated) transient Gemini `503 UNAVAILABLE` ("high
  demand") while verifying — confirmed via the server log and a direct
  standalone call to the same function succeeding moments later. Not a
  regression from this change.

## Interim transcript is now persisted (crash recovery, not live-display-only)

- **Follow-up to the Speako 3.0 review**: "if the process dies mid-sentence,
  that fragment is gone for good" was flagged as a real gap. Fixed.
- **New `interim_segments` table** — one row per (session, speaker),
  overwritten in place (never appended to), holding only the *latest*
  non-final STT result. Written from `session.ts`'s segment handler,
  throttled to at most once per 1.5s per speaker — writing every partial
  result (multiple/sec in active conversation) would hammer SQLite for a
  value that's about to be overwritten again anyway.
- **Cleared the moment it's superseded**: a real final segment for that
  speaker deletes the row immediately (`clearInterimSegment`); a normal
  `Session.stop()` clears every row for the session outright
  (`clearInterimSegmentsForSession`) — a clean stop has nothing left to
  recover, and the row is purely a recovery mechanism, not meant to
  accumulate.
- **Recovery only happens for sessions that never got a clean stop** —
  `closeOrphanedSessions()` (already ran at every app startup, closing any
  session left with `ended_at IS NULL`) now also promotes that session's
  leftover interim row to a real final `transcript_segments` row before
  clearing it — a best-effort recovery of whatever was being said the
  moment the previous process died, better than losing it outright. Blank/
  whitespace-only interim rows are discarded rather than recovered as an
  empty segment. A cleanly-ended session's interim rows are never touched
  by this path (it only looks at orphaned sessions), matching the "cleared
  on stop()" behavior above.
- `deleteSession()` also clears `interim_segments` for that session, same
  as every other per-session table.

## Verified local codebase indexing end-to-end, on a real repo, for real

- **The "unverified" flag from the Speako 3.0 review turned out to already
  be resolved by real usage** — checking the actual database found 3081
  real chunks already indexed under a repo named `officercc` (the user's
  own prior use of this feature), plus a smaller `speako-codebase-module`
  entry. The feature has clearly already been exercised for real; it just
  hadn't been verified by a human reviewing the actual output.
- **Additionally ran a fresh, isolated, from-scratch verification** — a
  small synthetic 3-file repo (auth/payments/README, distinct content),
  indexed via a temporary `codebaseLocalPaths` settings override scoped to
  only that one repo name (confirmed `runCodebaseIndex()` only touches
  repos actually present in that config value — the user's real `officercc`
  index was never re-touched by this). Real embedding calls, real
  `data/speako.db`. Result: walked → chunked → embedded → stored correctly,
  and semantic search (`searchCode()`) correctly matched
  "how do we send a password reset email" to the synthetic repo's
  `generateResetPasswordEmail` function (and, tellingly, *also* to a real,
  legitimately-relevant password-related method in the officercc corpus) —
  and "credit card charging logic" correctly matched only the synthetic
  `chargeCard` function, no false positives from the much larger real
  corpus. Test repo's chunks and the settings override were cleaned up
  afterward.
- **How to test this yourself, on any repo**: set `CODEBASE_LOCAL_PATHS`
  (`.env`, or Settings) to `name=C:\path\to\repo`, click "Index codebase"
  in Settings (or `POST /api/codebase/index`), then query
  `GET /api/codebase/status` or just try a design_dev-workflow prep run —
  it's the only workflow that queries `localCodebase`. Caps: 2000 files /
  20MB total / 500KB per file, excludes `node_modules`/`.git`/`dist`/etc
  (see `walkLocalRepo.ts`) — a very large repo will silently truncate
  rather than index everything, worth knowing before trusting a "did it
  find X" negative result.

## Review pass: workflow consistency fixes + a new live code-context trigger

- **sprintReview.ts was missing "last time's notes"** — every other recurring
  workflow (standup, sprint_planning, retro, one_on_one) already pulls the
  previous instance's summary/open items; sprint_review didn't. Added the
  same `previousSessionNotes` source, and the matching `WORKFLOW_STEPS`
  preview line.
- **sprintReview.ts and oneOnOne.ts built their query from the raw session
  name instead of `searchTopic()`** — meaning a ticket key or keyword typed
  only in the notes field (blank session name) wouldn't reach the Jira/
  Confluence/email/Teams queries, unlike design_dev/generic which already
  use `searchTopic` for exactly this reason. Fixed both — **carefully**, for
  one_on_one: `getOpenActionItemsByOwner()` does a plain substring match
  against the stored `owner` name, so it has to keep using the bare session
  name, not the notes-combined topic, or it'd stop matching anything the
  moment notes are present. Added a test asserting that specifically, since
  it's the kind of subtle regression a quick pattern-copy could reintroduce.
- **New `code_reference` trigger category** — Speako's live-trigger pipeline
  (5 categories: factual_claim, decision_point, vagueness, tone_shift,
  unanswered_question) had nothing for code/technical references, despite
  `design_dev` prep and `generic.ts` already gating on exactly this via
  `looksCodeRelated()` at prep time. Reused that same heuristic to fire
  live instead: a final segment matching it fires `code_reference`
  unconditionally (same principle as `factual_claim` — the raw detection is
  still worth logging in the Triggers tab even with nothing configured to
  ground it), and `generate.ts`'s suggestion step now branches per-category
  — `code_reference` searches the local codebase index instead of past-
  meeting RAG, suppressing outright (no suggestion, like an ungrounded
  factual claim) when local indexing isn't configured or nothing relevant
  turns up. Citation is `repoName/filePath` instead of a session name.
- **`actionItemDrafts.ts`'s five `suggestXFields()` functions were near-
  identical boilerplate** (only the schema and prompt intro actually
  differed) — pulled the shared guard/prompt-suffix/Gemini-call/log/parse
  shape into one `draftFields()` helper. Behavior is identical (same public
  functions, same fallback logic per field) — verified by the existing
  test suite passing unchanged.
- Looked at, but decided NOT to change: the Jira/Confluence write routes'
  description/content defaults (`server.ts`) already fall back to the real
  action item description whenever the client sends nothing — there wasn't
  actually a validation gap there on closer inspection.

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

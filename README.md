# Speako — AI Meeting Assistant

Captures live audio from your microphone (and, optionally, system/tab audio),
streams it to Google Cloud Speech-to-Text in real time, and shows a
live-updating, speaker-separated transcript in a local web page — persisting
finalized segments to SQLite as they arrive. On top of that: post-session
speaker identification and summarization, plus live sentiment tracking,
trigger detection, and RAG-grounded proactive suggestions during the meeting.

See [NOTES.md](./NOTES.md) for known limitations and empirical findings from
building this (several real API surprises are documented there, not just
theoretical caveats).

## Folder structure

```
src/
  audio-capture/   mic + system audio capture (spawns SoX), plus WAV recording
  transcription/   Google Speech-to-Text v2 streaming client + reconnect logic
  diarization/     on-demand post-session speaker identification (BatchRecognize)
  summarization/   on-demand meeting summary + action-item extraction (Gemini)
  sentiment/       live per-segment sentiment scoring (Cloud Natural Language API)
  triggers/        live trigger detection (factual claim/decision/vagueness/tone/silence)
  rag/             embeds past sessions + retrieves grounding context for suggestions
  suggestions/     category-specific prompts generating proactive suggestions
  storage/         SQLite schema and all persistence (transcript/summary/etc.)
  interface/        Express + WebSocket live transcript view
  session.ts       wires every live pipeline stage together
  index.ts         CLI entrypoint
```

## 1. Google Cloud setup

1. Create (or pick) a GCP project at https://console.cloud.google.com/.
2. Enable the **Cloud Speech-to-Text API** for that project:
   `APIs & Services > Enable APIs and Services > search "Cloud Speech-to-Text API" > Enable`.
3. Create a service account: `IAM & Admin > Service Accounts > Create Service Account`.
   Grant it the **Cloud Speech Client** role (or broader `Editor` for quick local testing).
4. Create a JSON key for that service account (`Keys > Add Key > Create new key > JSON`)
   and download it. Save it somewhere in this project, e.g. `./gcp-credentials.json`
   (this file is gitignored — never commit it).
5. Note your **project ID** (not the display name) from the GCP console.

This project uses the **chirp_3** model on the Speech-to-Text **v2 API**, which
is only available in the `us` and `eu` multi-region locations (not zonal regions
like `us-central1`) — see [NOTES.md](./NOTES.md).

## 2. Install SoX (audio capture)

Audio capture is done via [SoX](https://sourceforge.net/projects/sox/), spawned
as an external process (no native Node build required).

- Windows: install SoX (e.g. `choco install sox.portable`, or download the
  Windows build from SourceForge and unzip it anywhere — no installer needed).
  Either put `sox.exe` on your `PATH`, or point `SOX_BINARY` in `.env` at it
  directly (e.g. `./tools/sox-14.4.2/sox.exe`) — no PATH changes required.
  Test with `<path-to-sox> --version`.
- macOS: `brew install sox`
- Linux: `apt install sox` (or your distro's equivalent)

### System/tab audio (optional)

Windows has no built-in loopback recording device, so capturing "both sides" of
a call requires one of:

- **Stereo Mix**: some sound cards expose this in
  `Settings > Sound > Manage sound devices > Recording tab` (right-click to show
  disabled devices). Enable it if present.
- **A virtual audio cable** (e.g. [VB-CABLE](https://vb-audio.com/Cable/)):
  set your system's playback device to the virtual cable (or use "Listen to this
  device" routing), then capture from the cable's recording side.

### Finding exact device names

SoX's `waveaudio` driver uses the legacy Windows MME API, which reports device
names differently than the modern Settings app — **truncated to 31
characters** and sometimes reworded. Using the name shown in
`Settings > Sound` often does *not* match what SoX needs.

Run the included probe script to list the exact names SoX will see:
```
powershell -ExecutionPolicy Bypass -File scripts/list-audio-devices.ps1
```
Copy the printed name verbatim into `MIC_AUDIO_DEVICE` / `SYSTEM_AUDIO_DEVICE` in `.env`.

If you skip system audio setup, leave `SYSTEM_AUDIO_DEVICE` empty — Speako will
capture mic-only, single-channel audio (no "Others" speaker label).

## 3. Install dependencies

```
npm install
```

## 4. Configure

```
cp .env.example .env
```

Edit `.env`:
- `GOOGLE_APPLICATION_CREDENTIALS` — path to the service account JSON from step 1.
- `GCP_PROJECT_ID` — your project ID.
- `MIC_AUDIO_DEVICE` — your microphone's exact device name.
- `SYSTEM_AUDIO_DEVICE` — your loopback device's exact name, or leave empty.

## 5. Run

Development (no build step):
```
npm run dev
```

Production:
```
npm run build
npm start
```

Then open **http://localhost:3210** (or your configured `HTTP_PORT`). The
server starts with nothing recording — click **+ New session**, pick a
meeting type, and **Prepare session** (see "Pre-meeting prep" below); once
ready, click **Start recording** on the session card to begin. **Stop** ends
it, and **Save transcript** downloads the finalized transcript as a `.txt`
file (add `?format=json` to the export URL for JSON instead). `Ctrl+C` in
the terminal stops everything, including any in-progress session.

Transcript segments are persisted to `./data/speako.db` (SQLite) as they're
finalized, tagged with the session ID shown in the UI while recording.

### Sessions sidebar

The sidebar (always visible) lists every past session — name, relative time,
status, segment count — independent of whatever's currently on screen or
being recorded. Optionally name a session before starting it, or rename it
anytime by clicking the title in the main panel. Click a card to **view**
its transcript, run **Identify speakers**, **Save**, or permanently
**delete** it (✕ on the card, or the toolbar's Delete button for whichever
session is open) — a currently-recording session can't be deleted until
it's stopped. All of this is read from SQLite, not page state, so it
survives closing and reopening the browser.

### Speaker identification (optional, on-demand)

The live transcript separates "You" (mic) from "Others" (system audio) by
channel, not by identifying individual people. After stopping a session, the
**Identify speakers** button runs real diarization (chirp_3) over that
session's recording and replaces the transcript with "Speaker 1", "Speaker
2", etc. — this is **not automatic**; audio is only uploaded to the cloud
when you explicitly click it, on a per-session basis.

This requires a GCS bucket (one-time setup):
1. https://console.cloud.google.com/storage/browser → **Create bucket** →
   any globally-unique name, location `us` (multi-region, to match
   `GCP_SPEECH_LOCATION`), Standard storage, Uniform access.
2. On the bucket's **Permissions** tab → **Grant access** → add your service
   account email (from the credentials JSON's `client_email`) → role
   **Storage Object Admin**.
3. Set `GCS_BUCKET=your-bucket-name` in `.env`.

Leave `GCS_BUCKET` blank to disable the feature entirely — the button will
return an error explaining it's not configured, nothing else is affected.

### Meeting summary & action items (optional, on-demand)

The **Summary** and **Action Items** tabs are empty until you click
**Generate summary** on a stopped session — like diarization, nothing is
sent anywhere automatically. That one click makes two separate calls to the
Gemini API: one produces a structured summary (overview, key decisions,
discussion topics, next steps), the other extracts genuine action items only
(explicit commitments vs. softer inferred ones, each tagged accordingly) —
kept separate from the summary call for better precision on each. Action
items get a checkbox to mark done/open, editable anytime afterward.

Setup: get a free API key from https://aistudio.google.com/apikey and set
`GEMINI_API_KEY` in `.env`. Leave it blank to disable the feature — the
button will return a clear error instead of failing silently.

### Live sentiment, trigger detection & proactive suggestions (automatic)

Unlike diarization/summarization above, this group runs **automatically**
during recording — each piece only processes text already stored/shown live,
and needs to run live to be useful at all (a "generate triggers later"
button wouldn't help you *during* the meeting). Each has its own `.env`
toggle if you'd rather turn it off; see `.env.example` for all the knobs.

- **Sentiment**: every finalized segment gets scored via Cloud Natural
  Language API (needs the API enabled on your GCP project — same one used
  for Speech-to-Text, no separate credentials needed) and shown as a small
  colored dot next to the segment.
- **Speech adaptation**: `config/phrase-hints.json` is a versioned list of
  domain vocabulary (project names, tools, acronyms) that biases live
  recognition toward those terms. Edit it to add your own — it's meant to be
  a living document, not a one-time setup.
- **Trigger detection**: watches finalized segments for factual claims,
  decision points, vague commitments (via a Gemini classifier), tone shifts
  (via the sentiment scores), and unanswered questions (via a timer). A
  confidence threshold, per-category cooldown, and overall rate limit keep it
  from being noisy — tune via `.env` if you get too much or too little.
  Raw detections are visible in the **Triggers** tab.
- **RAG grounding**: every stopped session's transcript gets embedded
  (Gemini) into a small local corpus. When a trigger fires, the current
  moment is embedded too and compared against everything from *other* past
  sessions (never the live one) — if nothing clears the similarity
  threshold, no suggestion is generated rather than forcing a bad guess.
- **Suggestions panel**: sits next to the live transcript. Each card shows
  the suggestion, its trigger category, and a source citation (which past
  session it was grounded in) when applicable. **Accept**/**Dismiss** buttons
  log your feedback — useful data for tuning thresholds later, matching
  spec's original idea of using that signal to improve trigger accuracy over time.

### Pre-meeting prep

Speako is work-only — there's no "Personal" one-click mode anymore. Every new session goes through a meeting-type picker (Standup, Sprint Planning, Sprint Review, Retro, One-on-One, Design/Dev Discussion, or Other) and a **Prepare session** step before recording starts. Clicking **Prepare session**:

1. Creates the session immediately (shows "preparing…" in the sidebar) — recording is never blocked on prep finishing.
2. Runs a type-specific workflow in the background: Jira/Confluence/Bitbucket searches relevant to that meeting type, the previous same-type session's notes (auto-matched by name/subtype, see NOTES.md), and — if configured — durable `mem0-cloud` facts (one-on-ones) or `rag-cloud`/MyRAG external references (design/dev discussions).
3. Synthesizes everything into a **prep brief** via Gemini and seeds it into the session's meeting-state, so live trigger detection and suggestions are grounded from the first segment instead of starting cold.

Once ready, the session card shows a **Start recording** button. The brief itself is visible (and editable) in the **Prep Brief** tab, both before and during the meeting. If Jira/Confluence/Bitbucket are already configured for fact-checking, prep uses the same credentials — no extra setup. `mem0-cloud`/`rag-cloud`/Google Calendar are additional optional integrations (see `.env.example`); everything degrades gracefully to "skipped" if unconfigured, same as every other integration in this project.

### Sidebar history tabs (Meetings / Practice / Chat)

The sidebar's session list is split into three tabs by `session_kind`: **Meetings** (real recordings), **Practice** (roleplay runs against a prep brief), and **Chat** (ad-hoc voice-chat sessions). Both voice chat and practice now persist a real session + transcript (previously chat was fully ephemeral — nothing was saved), so both show up in history and can be reopened to view their transcript, same as any recorded meeting. Practice sessions still get coaching feedback on stop, same as before; chat sessions don't (there's nothing to score — it's a Q&A log, not a roleplay).

#### Implement with Claude Code (action items)

Some action items are code changes, not just meeting follow-ups. Each action item in the **Action Items** tab gets an **Implement with Claude Code** button that launches a background [Claude Code](https://claude.com/claude-code) CLI agent to make the actual change — requires the `claude` CLI installed and at least one repo configured in `CODEBASE_LOCAL_PATHS` (see "Local codebase indexing" below; if more than one is configured, pass `repoName` in the request body to pick which).

**Safety model, not just a convenience feature**: the agent runs in a freshly created, isolated git worktree (`claude --worktree`) — never your repo's actual working directory — with file edits allowed but `git commit`/`git push` explicitly denied (`--disallowedTools "Bash(git commit:*)" "Bash(git push:*)"`), confirmed by direct testing: asking the agent to edit a file *and* commit it resulted in the edit landing but the commit being flatly rejected. Once the agent finishes, Speako shows you the diff — nothing is applied automatically. You get two separate, explicit approval steps:

1. **Approve & Commit** — applies the diff to the real repo and commits it there (Speako's own action, not the agent's).
2. **Push** — a distinct second click, only enabled after committing. Nothing ever reaches a remote without this.

You can also **Discard** a change before or after review, which force-removes the worktree and throws the changes away. Background progress and results are broadcast live over the existing WebSocket, so the row updates in place — no polling needed on the frontend.

#### Pull request reviews (Bitbucket Server)

Beyond commit/file search, Speako can also check **your own pull request activity** — uses the same `BITBUCKET_SERVER_*` credentials, no extra setup. It surfaces three things: open PRs where you're a requested reviewer (with your current approval status), comments on pull requests you authored, and comments that @-mention your Bitbucket username anywhere you're already involved (as author or reviewer). Available as a voice-chat/practice tool ("My PR reviews" in Settings > Voice chat tools) and as an extra source in Sprint Planning/Sprint Review prep. Note: Bitbucket Server has no global cross-repo comment search, so "mentioned in comments" is scoped to PRs you're already touching, not every PR on the server — a real limitation, not a bug.

#### Local codebase indexing (Design/Dev Discussion prep)

Since most work meetings are software-engineering-focused, Design/Dev Discussion prep can also search source code already checked out on this machine — no cloning, no remote service, no credentials. Set `CODEBASE_LOCAL_PATHS` in `.env` to comma-separated `name=path` pairs (e.g. `officercc=C:\Users\me\dev\officercc`), then click **Index codebase** in the sidebar. This chunks and Gemini-embeds each configured repo's source files into a local SQLite table (`code_chunks`), the same pattern already used for past-meeting RAG. Re-indexing replaces a repo's chunks cleanly. The only network calls made are the Gemini embedding calls — source code itself never leaves this machine. Design/dev prep then surfaces matching snippets under `local_codebase`, alongside (not instead of) `myrag_external_refs`, which stays reserved for one-off external references like linked specs.

#### Outlook desktop calendar (fallback for meeting auto-detection)

If Google Calendar isn't configured, Speako falls back to reading upcoming meetings directly from classic desktop Outlook's Calendar folder via the same COM automation used for the email fallback above — no separate setup, and no merging with Google Calendar if both happen to be present (Google wins if configured; this is Outlook-only otherwise). Feeds the same meeting-type auto-detection and "prep this meeting" shortcuts Google Calendar powers. Expect a several-second delay on each call (Outlook COM startup + calendar scan) — this is a real, mostly-fixed cost of the approach, not a bug; see NOTES.md for a Restrict()-based fix that got this down from over a minute to ~9 seconds.

#### Outlook + Teams (Microsoft Graph)

Speako can fetch your recent Outlook emails and Teams 1:1/group chat messages directly, so `email`/`teams` fact-check/Q&A sources have real data without a separate ingestion agent (see `docs/EXTERNAL_INGESTION_PROMPT.md` for that alternative if you don't have Azure AD app-registration access):

1. Register an app at [entra.microsoft.com](https://entra.microsoft.com) (App registrations > New registration) — no redirect URI needed.
2. Under Authentication, enable **Allow public client flows**.
3. Under API permissions, add the delegated permissions `Mail.Read` and `Chat.Read` (both are user-consentable — no tenant admin approval needed).
4. Copy the app's **Application (client) ID** into `MS_GRAPH_CLIENT_ID` in `.env` (or Settings). If you registered a **single-tenant** app ("Accounts in this organizational directory only" — the default), also copy the **Directory (tenant) ID** from the same Overview page into `MS_GRAPH_TENANT_ID`; the default `common` only works for multi-tenant registrations and fails device-code sign-in with `AADSTS50059` otherwise (confirmed during setup — the tenant ID implied by your email domain can also differ from where the app is actually registered, so use the Overview page's value, not a guess).
5. Run `npm run msgraph-auth` once and follow the device-code prompt to sign in.

Once signed in, Speako polls Outlook/Teams automatically every `MS_GRAPH_POLL_MINUTES` (default 15) and writes raw messages into the same `external_messages` table the manual ingestion path uses — click **Index communications** in Settings afterward (or wait for your next manual click) to chunk/embed what's arrived. A **Sync now** button in Settings triggers an out-of-cadence sync. Teams *channel* messages aren't covered (that permission typically needs tenant-admin consent); only 1:1/group chats are synced.

**Known account-level failure modes** (not fixable from Speako's side — see NOTES.md): if *both* email (`MailboxNotEnabledForRESTAPI`) and Teams (`401 Unauthorized` on `/me/chats`, even with `Chat.Read` correctly granted) fail at once, check whether you signed in as a **B2B guest** rather than a native member of that tenant — call `GET https://graph.microsoft.com/v1.0/me` with the token and look at `userPrincipalName`; a `#EXT#` in it means guest, and guest identities have no real mailbox or Teams presence in the tenant they're a guest in. The fix is signing in (`npm run msgraph-auth`) with the account's actual home-tenant credentials instead. If only one source fails while the other works, that's a narrower issue: a genuinely hybrid/on-prem-hosted mailbox (Mail API only supports Exchange Online) or a missing Teams license, respectively.

#### Outlook desktop fallback (for mailboxes Graph can't reach)

If Graph's Mail API can't reach your mailbox at all (hybrid/on-premises Exchange, or the guest-account issue above) but you have **classic desktop Outlook** installed and connected to it, Speako can read mail via Outlook's own COM automation object model instead — it rides the desktop client's existing connection, so it doesn't care whether the mailbox is cloud or on-prem. Requires classic Outlook specifically; **"New Outlook"** (the newer PWA-style client) has no COM automation support at all.

No setup beyond having Outlook installed — click **Sync via Outlook desktop** in Settings. The first time in a session, Outlook's "Object Model Guard" will likely show a security prompt ("A program is trying to access e-mail information...") — approve it. This is manual-only, not polled automatically, precisely because of that prompt: an unattended background sync could silently stall waiting for an approval nobody sees. Fetches the Inbox only, going back `OUTLOOK_DESKTOP_LOOKBACK_HOURS` (default 48), and writes into the same `external_messages` table as the other two ingestion paths.

## Troubleshooting

- **"Missing required environment variable"**: check `.env` exists and is filled in.
- **"Failed to start SoX"**: SoX isn't installed or isn't on `PATH`.
- **No transcript appears**: verify device names in `.env` exactly match what
  Windows shows in the Recording devices list, and that credentials/project ID
  are correct — check the console for `[transcription] error:` or `[audio-capture] error:` logs.
- **Garbled or silent second channel**: confirm system audio is actually routed
  into `SYSTEM_AUDIO_DEVICE` (e.g. Windows playback device set to your virtual
  cable) — SoX will still open a device with no signal but you'll get empty
  transcripts for "Others".

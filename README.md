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
server starts with nothing recording — use the page's **Start recording**
button to begin a session, **Stop** to end it, and **Save transcript** to
download the finalized transcript as a `.txt` file (add `?format=json` to the
export URL for JSON instead). `Ctrl+C` in the terminal stops everything,
including any in-progress session.

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

### Pre-meeting prep (Personal vs. Work sessions)

New sessions default to **Personal** — the exact one-click flow above, unchanged. Toggling to **Work** before starting reveals a meeting-type picker (Standup, Sprint Planning, Sprint Review, Retro, One-on-One, Design/Dev Discussion, or Other) and a **Prepare session** button instead of Start. Clicking it:

1. Creates the session immediately (shows "preparing…" in the sidebar) — recording is never blocked on prep finishing.
2. Runs a type-specific workflow in the background: Jira/Confluence/Bitbucket searches relevant to that meeting type, the previous same-type session's notes (auto-matched by name/subtype, see NOTES.md), and — if configured — durable `mem0-cloud` facts (one-on-ones) or `rag-cloud`/MyRAG external references (design/dev discussions).
3. Synthesizes everything into a **prep brief** via Gemini and seeds it into the session's meeting-state, so live trigger detection and suggestions are grounded from the first segment instead of starting cold.

Once ready, the session card shows a **Start recording** button. The brief itself is visible (and editable) in the **Prep Brief** tab, both before and during the meeting. If Jira/Confluence/Bitbucket are already configured for fact-checking, prep uses the same credentials — no extra setup. `mem0-cloud`/`rag-cloud`/Google Calendar are additional optional integrations (see `.env.example`); everything degrades gracefully to "skipped" if unconfigured, same as every other integration in this project.

#### Local codebase indexing (Design/Dev Discussion prep)

Since most work meetings are software-engineering-focused, Design/Dev Discussion prep can also search source code already checked out on this machine — no cloning, no remote service, no credentials. Set `CODEBASE_LOCAL_PATHS` in `.env` to comma-separated `name=path` pairs (e.g. `officercc=C:\Users\me\dev\officercc`), then click **Index codebase** in the sidebar. This chunks and Gemini-embeds each configured repo's source files into a local SQLite table (`code_chunks`), the same pattern already used for past-meeting RAG. Re-indexing replaces a repo's chunks cleanly. The only network calls made are the Gemini embedding calls — source code itself never leaves this machine. Design/dev prep then surfaces matching snippets under `local_codebase`, alongside (not instead of) `myrag_external_refs`, which stays reserved for one-off external references like linked specs.

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

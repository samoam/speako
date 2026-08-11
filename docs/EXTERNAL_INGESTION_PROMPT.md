# External communications ingestion — instructions for the daily-indexing agent

> **Note:** Speako can now also fetch Outlook email and Teams chat messages natively via
> Microsoft Graph (`src/integrations/msGraphSync.ts`, `npm run msgraph-auth`) — see
> `.env.example`'s `MS_GRAPH_*` section and NOTES.md. That path requires an Azure AD app
> registration you control; if you don't have the access to create one, or want a source
> Graph doesn't cover, this document describes the manual alternative: any external agent
> with its own access writes directly into Speako's database. Both paths write to the same
> `external_messages` table and are safe to use together — the upsert key (`id`) is scoped
> per source, so there's no collision as long as each writer uses stable, source-specific ids.

This is a standalone task description for whatever agent runs your daily email/Teams
ingestion job (Claude Desktop with Microsoft 365 access, a scheduled script, etc). It has
no dependency on Speako's code — it only needs SQLite write access to Speako's database
file (`DB_PATH` in Speako's `.env`, default `./data/speako.db`).

Speako does **not** fetch email or Teams messages itself via this path. This task is the
only thing that writes to the `external_messages` table for sources it covers; Speako only
reads from it and does the chunking/embedding on its own side (`POST /api/communications/index`,
or the "Index communications" button in Settings) — regardless of whether a row came from
this task or from the native Microsoft Graph sync above.

## What to do, once per run

1. Using your Microsoft 365 access, fetch work emails and Teams messages from since the
   last run. Use a lookback window with overlap (e.g. the last 48 hours, not just "since
   midnight") so a missed day doesn't create a gap — re-inserting an already-seen message
   is harmless (see upsert semantics below).
2. For each message, extract:
   - `id` — a stable identifier from the source system (the email's `Message-Id` header, or
     the Teams message id). This is the upsert key — it must be the same value if you see
     this exact message again on a later run.
   - `source` — exactly `"email"` or `"teams"`.
   - `title` — the email subject, or a short Teams channel/topic label. Can be null.
   - `participants` — a JSON-encoded array of names/emails involved (senders, recipients,
     channel members), e.g. `["alice@acceo.com","bob@acceo.com"]`.
   - `occurred_at` — an ISO-8601 timestamp of when the message was sent.
   - `body_text` — **plain text only**. Strip HTML markup, quoted-reply chains ("On Tue,
     Alice wrote: > ..."), signature blocks, and any Teams @-mention markup. Speako's
     chunker does not do this cleanup for you — noisy input produces noisy search results.
3. Upsert into `external_messages` in Speako's SQLite database:

   ```sql
   INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     title = excluded.title,
     participants = excluded.participants,
     occurred_at = excluded.occurred_at,
     body_text = excluded.body_text,
     indexed_at = NULL;
   ```

   **The one subtlety that matters**: on a fresh insert, leave `indexed_at` unset (it
   defaults to `NULL`) so Speako's indexer picks it up. On an update to an existing id (the
   message was edited, or you're re-fetching it), the `ON CONFLICT` clause above explicitly
   resets `indexed_at` back to `NULL` — **do not** write an `ON CONFLICT DO NOTHING` or skip
   the update, or an edited message will keep its stale chunks forever.
4. **Do not compute embeddings.** That's Speako's job (it already has its Gemini
   configuration); your only responsibility is getting clean, correctly-shaped raw text into
   `external_messages`. Do not write anything to `external_message_chunks` — that table is
   Speako-owned.

## Table schema (for reference — Speako creates this automatically on first run)

```sql
CREATE TABLE external_messages (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,        -- 'email' | 'teams'
  title TEXT,
  participants TEXT,           -- JSON array of strings
  occurred_at TEXT NOT NULL,   -- ISO-8601
  body_text TEXT NOT NULL,     -- plain text
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at TEXT               -- leave NULL; Speako sets this once processed
);
```

## After writing

Nothing else to do — Speako's own indexing step picks up any row with `indexed_at IS NULL`
next time it runs (manually via the Settings "Index communications" button, or however
you've chosen to trigger it). If Speako isn't running when this task runs, that's fine —
SQLite's WAL mode means writes just sit in the file until Speako next reads them.

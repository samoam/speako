# Working on Speako

Read [README.md](./README.md) for what the app does and folder structure. Read [NOTES.md](./NOTES.md) when you need the empirical detail behind a specific area (API quirks, confirmed-live behavior, past bugs and their fixes) — it's a long running log, not something to read end to end.

## House style — read this before writing code here

- **Comments explain *why*, not *what*.** This codebase writes comments that record a non-obvious constraint, a workaround for a specific confirmed bug, or the reasoning behind a design choice — never a restatement of what the next line does. Match this: don't add "// increment counter"-style comments, and don't remove an existing comment that's carrying real information.
- **"Confirmed live" is a real standard, not a figure of speech.** Comments throughout the code say things like "confirmed live that X" when a claim about an external API/CLI's behavior was actually verified by running it, as opposed to assumed from docs or training data. When you add code that depends on an external tool's undocumented behavior (a CLI flag, a config file's exact shape, an API response field), verify it the same way before committing to it in a comment — or say plainly that it's unverified, rather than writing a "confirmed live" comment for something you didn't actually confirm.
- **No speculative abstraction.** Don't add config flags, generic interfaces, or extensibility points for a use case that doesn't exist yet. Three similar lines beat a premature helper.
- **Additive schema migrations.** `src/storage/db.ts` never destructively alters an existing table in place for a fresh column — see its guarded `PRAGMA table_info` + `ALTER TABLE` pattern throughout. A NOT NULL/FK change on an existing table uses the rename-rebuild-copy-drop idiom (search `RENAME TO ..._old` in db.ts for a worked example), guarded to run once.

## The draft-gate pattern

Most things in this app that write somewhere external (Jira, Confluence, Bitbucket, a git repo, a chat reply) go through the generic draft-gate system (`src/drafts/types.ts`'s `DraftHandler`, `src/drafts/draftService.ts`, table `drafts`/`draft_revisions`): generate a proposed action, let the user review/refine/edit it, then execute only on explicit approval through one or more named `gates`. Adding a new kind of AI-proposed write action means implementing a `DraftHandler`, not inventing a new one-off approve endpoint — check `src/drafts/kinds/` for the closest existing example first.

## The orchestration-run pattern

A multi-phase background pipeline with a live checklist + streaming log (PR review, the Jira-implement cycle and its fix / review-feedback rounds) is an **orchestration run**: `src/orchestration/engine.ts` executes a `RunDefinition` (`src/orchestration/types.ts`) whose steps are data — sequential entries or parallel groups, each with an optional `timeoutMs`, `optional` (a failure doesn't sink the run) and `approval` (the run parks at `waiting_approval` until `approveRun`). Runs live in `orchestration_runs` + `run_events` (`src/storage/runRepository.ts`); a kind's own result record (`pr_review_requests`, `dev_cycles`) keeps the *results* and points at its run via `run_id`, while the run owns the live steps/log. Adding a pipeline means a new file in `src/orchestration/kinds/` registered from its `index.ts`, not an unawaited async function in `server.ts`. Runs still hand off into the draft-gate system for the actual external writes (posting a PR comment, opening a PR, transitioning a Jira ticket).

## Testing

- Tests use Node's built-in test runner (`node:test` + `node:assert/strict`), not Jest — `npm test` runs a fixed, explicit list of test files defined in `package.json`'s `"test"` script. **A new test file must be added to that list or it silently never runs.**
- Repository tests hit a real (temp) SQLite database, not a mock — mock only true external boundaries (child_process/CLI calls, `fetch` to a third-party API, the Gemini client). See `tests/setEnv.js` for how the test DB is set up.
- Before treating a change as done: run `npx tsc --noEmit -p tsconfig.json` and `npm test` (the full suite currently runs in a few minutes — background it and wait for the notification rather than polling).

## Windows environment

Dev machine is Windows. `os.tmpdir()`/paths use backslashes; several integrations normalize to forward slashes to match a specific external tool's own convention (e.g. Claude Code's `~/.claude.json` trust-cache keys) — don't assume Unix path handling works untested.

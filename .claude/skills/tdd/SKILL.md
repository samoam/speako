---
name: tdd
description: Test-driven development in this repo. Use when building a new feature or fixing a bug test-first, or when adding coverage for existing behavior.
---

# Test-driven development, Speako-style

The red → green loop, adapted to this repo's actual test setup (see [CLAUDE.md](../../../CLAUDE.md)'s Testing section first: `node:test`, the fixed file list in `package.json`'s `test` script, real-SQLite repository tests).

## What a good test here looks like

Test through the public interface a caller actually uses — a repository function, a draft handler's `generate`/`execute`, a route's behavior — never an internal implementation detail. A good test reads like a spec: `tests/prReviewRequestRepository.test.ts`'s `'getLatestPrReviewRequestForTask: returns the most recent of several requests'` tells you exactly what capability exists, and survives a refactor of how that function is implemented internally.

## Seams: where tests go in this repo

- **Repository functions** (`src/storage/*Repository.ts`): test against a real (temp) SQLite DB, per existing convention — never mock `db`. Seed via the repo's own insert functions, not raw SQL, unless the thing under test is the schema itself.
- **Draft handlers / orchestration** (`src/drafts/kinds/*.ts`, `server.ts` route logic): mock only the true external boundary — `child_process`/CLI calls (`claude`, `gemini`, `git`), `fetch` to Jira/Confluence/Bitbucket, the Gemini client. Don't mock another module in this codebase you also own.
- **Pure logic** (prompt builders, parsers, scoring functions): plain unit tests, no mocking needed.

Before writing a test, know which of these three you're at — it decides what (if anything) gets mocked.

## Anti-patterns to avoid

- **Implementation-coupled**: reaching into a private field, querying the DB directly instead of through the repository's own getter, or mocking a module this codebase itself owns. Tell: the test breaks on a refactor even though behavior didn't change.
- **Tautological**: asserting a value computed the same way the code computes it. Expected values come from an independent source — a literal, a worked example, a real prior bug's reproduction — not a copy of the implementation's own formula.
- **Horizontal slicing**: writing a pile of tests before any implementation. Work in vertical slices — one behavior, one test, minimal code to pass it, repeat — same as this codebase's own incremental build history (see NOTES.md's "verified live before the next" pattern).

## The loop

1. **Red**: write the failing test first, for the next small behavior only — don't anticipate future cases.
2. **Green**: write the minimum code to pass it.
3. **Add the new/changed test file to `package.json`'s `test` script list** — a file not listed there silently never runs (see CLAUDE.md).
4. Refactoring is a separate pass (use `/code-review` or `/simplify` after, not mid-loop).
5. Before calling it done: `npx tsc --noEmit -p tsconfig.json` and the full `npm test` (background it, wait for the notification).

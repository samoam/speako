---
name: resolving-merge-conflicts
description: Use when resolving an in-progress git merge/rebase conflict in this repo.
---

1. **See the current state** of the merge/rebase — `git status`, the conflicting files, and `git log` on both sides.

2. **Find the primary sources** for each conflict. Understand why each side changed the code, not just what changed — check nearby comments (this repo comments the *why* heavily, see [CLAUDE.md](../../../CLAUDE.md)), commit messages, and related test files.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and say so in a short note (to the user, not as a code comment unless it documents a real non-obvious constraint). Never invent new behavior to paper over a conflict. Always resolve; never `--abort` without telling the user why.

4. **Run this repo's checks**: `npx tsc --noEmit -p tsconfig.json`, then `npm test` (background it — the full suite takes a few minutes; wait for the notification instead of polling). Fix anything the merge broke before continuing.

5. **Finish the merge/rebase.** Stage everything and commit (or continue the rebase until every commit is replayed). Never skip hooks (`--no-verify`) to force it through.

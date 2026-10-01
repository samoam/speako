import { StructuredDevPlan } from './devPlan';
import { runClaudeCodeReview } from '../integrations/claudeCodeCli';

/**
 * Structured output for the merge step (Jira-implement pipeline's
 * Merge & Review step) — constrains runClaudeCodeReview's answer to a single
 * unified-diff string plus a short human-readable explanation of how the two
 * implementations were reconciled. Deliberately schema-constrained TEXT
 * output, not a write-mode agent run: producing "one merged diff" from two
 * candidate diffs is done entirely inside the agent's own JSON answer, never
 * by touching a working tree, so this call stays read-only like every other
 * runClaudeCodeReview use in this codebase that isn't an explicit gated write
 * (see plan §3.3 of the Jira-implement design for why this was chosen over a
 * third write-mode merge worktree).
 */
export const MERGE_IMPLEMENTATIONS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    mergedDiff: {
      type: 'string',
      description: 'A single unified diff (git diff format, applicable via `git apply`) reconciling both implementations into one — the version a human should review before it is applied to the real branch.',
    },
    reconciliationNotes: {
      type: 'string',
      description: 'Short, plain-language explanation of how the two implementations were reconciled — which one was favored where they overlapped, and why, and what (if anything) was combined from both.',
    },
  },
  required: ['mergedDiff', 'reconciliationNotes'],
};

export interface MergedImplementation {
  mergedDiff: string;
  reconciliationNotes: string;
}

/**
 * Builds the merge prompt handed to `claude -p` (runClaudeCodeReview) against
 * worktree A (Claude's own implementation worktree — already has Claude's
 * changes on disk, so the agent can inspect them directly rather than only
 * from a diff string) with Gemini's diff supplied as text for comparison.
 */
export function buildMergePrompt(plan: StructuredDevPlan, claudeDiff: string, geminiDiff: string, baseBranch: string): string {
  return [
    `Two independent AI engineers each implemented the same approved plan in their own separate worktree, off the same branch (base: ${baseBranch}). Your job is to reconcile their two implementations into a single, coherent merged diff a human can review and apply.`,
    `The approved plan:\n${JSON.stringify(plan, null, 2)}`,
    `Implementation A ("claude") diff — this is what's currently on disk in your own working directory (you can Read the actual files, not just this diff text):\n${claudeDiff}`,
    `Implementation B ("gemini") diff (for comparison only — not present in your working directory):\n${geminiDiff}`,
    `Produce ONE merged unified diff (git diff format, applicable via \`git apply\`) against the ${baseBranch} base. Where the two implementations agree or one is a strict subset of the other, use the more complete/correct version. Where they genuinely diverge on approach, prefer whichever better matches the approved plan and this codebase's existing conventions (verify by reading the real code, don't guess). Do not simply concatenate both — the result must be one coherent, non-duplicated change that a reviewer could apply cleanly.

Do not write or edit any files yourself — express the merged result entirely as the mergedDiff string in your structured answer.`,
  ].join('\n\n');
}

export async function mergeImplementations(
  plan: StructuredDevPlan,
  claudeDiff: string,
  geminiDiff: string,
  baseBranch: string,
  worktreePath: string,
  onProgress?: (message: string) => void
): Promise<MergedImplementation> {
  const prompt = buildMergePrompt(plan, claudeDiff, geminiDiff, baseBranch);
  const result = await runClaudeCodeReview(prompt, worktreePath, { jsonSchema: MERGE_IMPLEMENTATIONS_JSON_SCHEMA, onProgress, model: 'sonnet' });
  if (!result.structuredOutput?.mergedDiff) {
    throw new Error('The merge agent did not return a mergedDiff.');
  }
  return { mergedDiff: result.structuredOutput.mergedDiff, reconciliationNotes: result.structuredOutput.reconciliationNotes ?? '' };
}

/**
 * Chat-to-refine for the Merge & Review step (POST /api/jira-implement/:id/merge/refine)
 * — adjusts the already-produced merged diff per a human instruction, optionally
 * scoped to one file/line (the spec's "chat about the global implementation OR
 * specific code"). Same read-only, structured-text-output shape as mergeImplementations.
 */
export async function refineMergedDiff(
  currentDiff: string,
  instruction: string,
  baseBranch: string,
  worktreePath: string,
  scope?: { filePath?: string; line?: number },
  onProgress?: (message: string) => void
): Promise<MergedImplementation> {
  const scopeText = scope?.filePath ? ` (focused on ${scope.filePath}${scope.line ? `:${scope.line}` : ''})` : '';
  const prompt = [
    `You previously produced this merged diff (git diff format) against base branch ${baseBranch}:\n${currentDiff}`,
    `The developer reviewing it has this feedback${scopeText}: ${instruction}`,
    `Produce an updated merged diff addressing this feedback. Read the real files in your working directory (they already reflect the diff above) before making further changes — verify anything you're unsure of rather than guessing. Do not write or edit any files yourself — express the result entirely as the mergedDiff string in your structured answer.`,
  ].join('\n\n');
  const result = await runClaudeCodeReview(prompt, worktreePath, { jsonSchema: MERGE_IMPLEMENTATIONS_JSON_SCHEMA, onProgress, model: 'sonnet' });
  if (!result.structuredOutput?.mergedDiff) {
    throw new Error('The refine agent did not return a mergedDiff.');
  }
  return { mergedDiff: result.structuredOutput.mergedDiff, reconciliationNotes: result.structuredOutput.reconciliationNotes ?? '' };
}

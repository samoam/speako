import { BuildFailureAnalysis } from './buildFailureClassification';

/**
 * Deliberately scoped — a fix agent gets the classification's own evidence
 * and suggestion, not "go explore the codebase and figure it out," so it
 * can't wander into unrelated changes the way a from-scratch implementation
 * prompt might. The explicit "do not weaken or disable the test" instruction
 * is the guard against the failure-classification worst case: silently
 * "fixing" a real regression by loosening the assertion that caught it.
 */
export function buildFixPrompt(params: { branch: string; buildNumber: number; analysis: BuildFailureAnalysis; ticketKey: string | null }): string {
  return `Build #${params.buildNumber} on branch ${params.branch} failed${params.ticketKey ? ` (ticket ${params.ticketKey})` : ''}.

Classification: ${params.analysis.category} (confidence ${params.analysis.confidence}).
Summary: ${params.analysis.summary}

Failing test(s): ${params.analysis.suspectTests.join(', ') || '(none identified)'}
Suspect files: ${params.analysis.suspectFiles.join(', ') || '(none identified)'}
Suggested fix: ${params.analysis.suggestedFix || '(not specified — investigate the failure yourself before changing anything)'}

Evidence from the build log:
${params.analysis.evidence.join('\n') || '(no specific evidence captured)'}

Fix the underlying cause in these files only. Do not modify unrelated files, do not weaken or delete the failing assertion(s), and do not disable or skip the test. If you cannot determine a safe fix, say so in your final message rather than guessing.`;
}

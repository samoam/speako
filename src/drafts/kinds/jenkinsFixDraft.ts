import { JenkinsBuildRow, getJenkinsBuildByJobAndNumber } from '../../storage/jenkinsBuildRepository';
import { DevCycle, getDevCycle } from '../../storage/devCycleRepository';
import { createCodeChangeRequest } from '../../storage/codeChangeRequestRepository';
import { startClaudeCodeTask } from '../../integrations/claudeCodeCli';
import { pollCodeChangeRequest } from '../../integrations/codeChangePoller';
import { BuildFailureAnalysis } from '../../dev/buildFailureClassification';
import { buildFixPrompt } from '../../dev/buildFixPrompt';
import { extractTicketKeyFromBranch } from '../../dev/branchNaming';
import { DraftHandler } from '../types';
import { getDraftBroadcaster } from '../draftService';

export interface JenkinsFixSubject {
  build: JenkinsBuildRow;
  cycle: DevCycle;
}

export interface JenkinsFixContent {
  prompt: string;
  summary: string;
  category: string;
  suspectFiles: string[];
  suspectTests: string[];
}

/** subjectId is "<jobPath>#<buildNumber>" — the exact same format jenkins_build tasks already use as their tasks.external_ref (see taskSync.ts's syncJenkins), so the client can pass a task's externalRef straight through with no extra lookup. Split on the LAST '#' since jobPath itself never contains one, but is otherwise a free-form '/'-separated Jenkins path. */
function parseSubjectId(subjectId: string): { jobPath: string; buildNumber: number } | null {
  const hashIndex = subjectId.lastIndexOf('#');
  if (hashIndex === -1) return null;
  const jobPath = subjectId.slice(0, hashIndex);
  const buildNumber = Number(subjectId.slice(hashIndex + 1));
  if (!jobPath || !Number.isFinite(buildNumber)) return null;
  return { jobPath, buildNumber };
}

/**
 * Proposes a scoped code fix for a classified Jenkins build failure —
 * refused at generate() time unless the classification says `fixable`
 * (compile_error/lint_error/test_regression only; infra_failure/flaky_test
 * are never proposed for an automatic fix, per the blueprint). Dispatch and
 * gating mirror devPlanDraft.ts exactly: startClaudeCodeTask into the
 * cycle's own worktree, a code_change_requests row the existing commit/push
 * gates already handle, no new CLI plumbing.
 */
export const jenkinsFixDraft: DraftHandler<JenkinsFixSubject> = {
  kind: 'jenkins_fix',
  subjectKind: 'jenkins_build',
  gates: [{ key: 'fix', label: 'Dispatch fix' }],
  redoStrategy: 'fresh',
  loadSubject(subjectId) {
    const parsed = parseSubjectId(subjectId);
    if (!parsed) return undefined;
    const build = getJenkinsBuildByJobAndNumber(parsed.jobPath, parsed.buildNumber);
    if (!build || !build.devCycleId) return undefined;
    const cycle = getDevCycle(build.devCycleId);
    if (!cycle || !cycle.worktreePath) return undefined;
    return { build, cycle };
  },
  async generate(input) {
    const { build, cycle } = input.subject;
    const analysis = build.classificationJson as BuildFailureAnalysis | null;
    if (!analysis) throw new Error('This build has not been classified yet.');

    if (input.redo) {
      const priorContent = input.redo.priorContent as JenkinsFixContent;
      const addendum = input.redo.instruction
        ? `\n\nAdditional context from the developer: ${input.redo.instruction}`
        : '\n\nThe previous fix attempt did not resolve the build — try a different approach.';
      return { mode: 'draft', content: { ...priorContent, prompt: `${priorContent.prompt}${addendum}` } };
    }
    if (input.instruction) {
      const priorContent = input.priorContent as JenkinsFixContent;
      return { mode: 'draft', content: { ...priorContent, prompt: `${priorContent.prompt}\n\nAdditional context from the developer: ${input.instruction}` } };
    }

    if (!analysis.fixable) {
      const alternative = analysis.category === 'infra_failure' || analysis.category === 'flaky_test' ? 'try rebuilding instead' : 'flag it for manual investigation';
      throw new Error(`This build's failure (${analysis.category}) isn't something a code fix can address — ${alternative}.`);
    }

    const ticketKey = extractTicketKeyFromBranch(build.branchName ?? '') ?? cycle.ticketKey;
    const prompt = buildFixPrompt({ branch: build.branchName ?? cycle.branchName ?? '', buildNumber: build.buildNumber, analysis, ticketKey });
    return {
      mode: 'draft',
      content: { prompt, summary: analysis.summary, category: analysis.category, suspectFiles: analysis.suspectFiles, suspectTests: analysis.suspectTests },
    };
  },
  async execute(_gateKey, ctx) {
    const { cycle } = ctx.subject;
    const content = ctx.content as JenkinsFixContent;
    const { cliSessionId } = await startClaudeCodeTask(content.prompt, cycle.worktreePath!);
    const request = createCodeChangeRequest({
      devCycleId: cycle.id,
      taskId: cycle.taskId ?? undefined,
      origin: 'jenkins_fix',
      repoName: cycle.repoName,
      repoPath: cycle.worktreePath!,
      cliSessionId,
    });
    pollCodeChangeRequest(request.id, getDraftBroadcaster()).catch((err: any) => {
      console.error(`[jenkins-fix] polling failed for code change request ${request.id}:`, err.message);
    });
    return { codeChangeRequestId: request.id, cliSessionId };
  },
  legacyBroadcast(draft) {
    const parsed = parseSubjectId(draft.subjectId);
    return parsed ? [{ type: 'jenkins-fix-updated', jobPath: parsed.jobPath, buildNumber: parsed.buildNumber }] : undefined;
  },
};

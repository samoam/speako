import { getJenkinsBuildByJobAndNumber, JenkinsBuildRow } from '../../storage/jenkinsBuildRepository';
import { getCodeChangeRequest } from '../../storage/codeChangeRequestRepository';
import { getDevCycle } from '../../storage/devCycleRepository';
import { Run, TERMINAL_RUN_STATUSES } from '../../storage/runRepository';
import { pollJenkinsBuilds } from '../../dev/jenkinsMonitor';
import { buildFixPrompt } from '../../dev/buildFixPrompt';
import { BuildFailureAnalysis } from '../../dev/buildFailureClassification';
import { registerRunKind, startRun, cancelRun, emitEvent } from '../engine';
import { RunDefinition, StepEntry } from '../types';
import {
  DEV_CYCLE_SUBJECT_KIND,
  DevCycleBaseState,
  FailedBuild,
  applyAndPushStep,
  buildAndTestStep,
  cycleOf,
  dispatchClaudeChange,
  ensureCycleWorktree,
  getLatestDevCycleRun,
  startPrDraftAfterGreenBuild,
} from './devCycleSteps';

export const DEV_CYCLE_FIX_RUN_KIND = 'dev_cycle_fix';

/** Rounds of "fix → push → rebuild" the cycle tries on its own before leaving the red build to the developer. */
export const MAX_FIX_ROUNDS = 3;

export interface DevCycleFixRunState extends DevCycleBaseState {
  failedBuildToFix: FailedBuild;
  round: number;
  fixRequestId?: number;
}

/**
 * The build-fix loop: a red build on the cycle's branch starts one of these
 * (from the main run's finalize, or from a previous round's) — the recorded
 * failure classification feeds a scoped fix agent, the fix diff waits for
 * the human's approval, is committed and pushed, and the branch is built
 * again. A still-red build starts the next round, up to MAX_FIX_ROUNDS; a
 * green one drafts the PR like the main pipeline would have.
 */
function steps(): StepEntry<DevCycleFixRunState>[] {
  return [
    {
      key: 'analyze_failure',
      label: 'Analyze the failing build',
      async run(ctx) {
        const { jobPath, buildNumber } = ctx.state.failedBuildToFix;
        let build = getJenkinsBuildByJobAndNumber(jobPath, buildNumber);
        if (!build?.classificationJson) {
          // The monitor classifies a settled build; make sure that happened.
          await pollJenkinsBuilds(emitEvent).catch(() => undefined);
          build = getJenkinsBuildByJobAndNumber(jobPath, buildNumber);
        }
        const analysis = build?.classificationJson as BuildFailureAnalysis | null | undefined;
        if (!build || !analysis) throw new Error(`Build #${buildNumber} has not been classified yet — rerun the build, or fix it by hand.`);
        if (!analysis.fixable) {
          const alternative = analysis.category === 'infra_failure' || analysis.category === 'flaky_test' ? 'rerun the build instead' : 'it needs a manual look';
          throw new Error(`Build #${buildNumber} failed with ${analysis.category} — not something a code fix can address; ${alternative}.`);
        }
        ctx.log(`Build #${buildNumber}: ${analysis.category} — ${analysis.summary}`);
        if (ctx.state.failedBuildToFix.newFailures.length) ctx.log(`New failing tests: ${ctx.state.failedBuildToFix.newFailures.join(', ')}`);
        return `${analysis.category}: ${analysis.summary}`;
      },
    },
    {
      key: 'fix',
      label: 'Fix (Claude)',
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const { jobPath, buildNumber, newFailures } = ctx.state.failedBuildToFix;
        const build = getJenkinsBuildByJobAndNumber(jobPath, buildNumber) as JenkinsBuildRow;
        const analysis = build.classificationJson as BuildFailureAnalysis;
        const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
        // The verdict's own list of new failures is the ground truth for what
        // this branch broke — more precise than the classifier's suspects.
        const suspectTests = newFailures.length ? newFailures : analysis.suspectTests;
        const prompt = buildFixPrompt({ branch: cycle.branchName!, buildNumber, analysis: { ...analysis, suspectTests }, ticketKey: cycle.ticketKey });
        ctx.log(`Fix round ${ctx.state.round}: asking Claude to fix ${suspectTests.length ? suspectTests.length + ' failing test(s)' : 'the failure'}…`);
        const outcome = await dispatchClaudeChange(ctx, cycle, prompt, worktreePath, 'jenkins_fix');
        ctx.state.fixRequestId = outcome.request.id;
        if (outcome.status !== 'ready') throw new Error(outcome.error ?? 'The fix agent produced no change.');
        ctx.log('Fix ready for review — approve to commit, push and rebuild.');
        return 'Fix ready for review.';
      },
    },
    applyAndPushStep<DevCycleFixRunState>({
      key: 'apply_fix_and_push',
      label: 'Apply fix & push',
      request: (state) => (state.fixRequestId ? getCodeChangeRequest(state.fixRequestId) : undefined),
      commitMessage: (cycle, _summary, state) => `${cycle.ticketKey} fix failing tests (build #${state.failedBuildToFix.buildNumber})`,
    }),
    buildAndTestStep<DevCycleFixRunState>(),
  ];
}

export const devCycleFixRunDefinition: RunDefinition<DevCycleFixRunState> = {
  kind: DEV_CYCLE_FIX_RUN_KIND,
  steps,
  async finalize(run, outcome) {
    if (outcome === 'done') {
      await startPrDraftAfterGreenBuild(run.state.cycleId);
      return;
    }
    if (outcome === 'failed' && run.state.failedBuild) await startFixRoundIfPossible(run.state.cycleId, run.state.failedBuild, run.state.round + 1);
  },
};

registerRunKind(devCycleFixRunDefinition);

/** Starts a fix round for a red build, cancelling any run still in flight for the cycle. */
export async function startDevCycleFixRun(cycleId: number, failedBuild: FailedBuild, round = 1): Promise<Run<DevCycleFixRunState>> {
  const previous = getLatestDevCycleRun(cycleId);
  if (previous && !TERMINAL_RUN_STATUSES.includes(previous.status)) await cancelRun(previous.id);
  return startRun<DevCycleFixRunState>({
    kind: DEV_CYCLE_FIX_RUN_KIND,
    subjectKind: DEV_CYCLE_SUBJECT_KIND,
    subjectId: String(cycleId),
    state: { cycleId, failedBuildToFix: failedBuild, round },
  });
}

/**
 * The automatic follow-up to a red build: another round while rounds
 * remain and the failure is something a code fix can address. Anything
 * else (infra, flaky, rounds exhausted) stays failed for the developer,
 * with the reason in the run log.
 */
export async function startFixRoundIfPossible(cycleId: number, failedBuild: FailedBuild, round: number): Promise<Run<DevCycleFixRunState> | null> {
  if (round > MAX_FIX_ROUNDS) {
    console.log(`[dev-cycle] cycle ${cycleId}: build #${failedBuild.buildNumber} still red after ${MAX_FIX_ROUNDS} fix rounds — leaving it to the developer.`);
    return null;
  }
  if (!getDevCycle(cycleId)) return null;
  const build = getJenkinsBuildByJobAndNumber(failedBuild.jobPath, failedBuild.buildNumber);
  const analysis = build?.classificationJson as BuildFailureAnalysis | null | undefined;
  if (analysis && !analysis.fixable) {
    console.log(`[dev-cycle] cycle ${cycleId}: build #${failedBuild.buildNumber} failed with ${analysis.category} — no automatic fix round.`);
    return null;
  }
  return startDevCycleFixRun(cycleId, failedBuild, round);
}

import { getJenkinsBuildByJobAndNumber, JenkinsBuildRow } from '../../storage/jenkinsBuildRepository';
import { getCodeChangeRequest } from '../../storage/codeChangeRequestRepository';
import { getDevCycle } from '../../storage/devCycleRepository';
import { Run, TERMINAL_RUN_STATUSES } from '../../storage/runRepository';
import { pollJenkinsBuilds } from '../../dev/jenkinsMonitor';
import { getTestReport } from '../../integrations/jenkinsClient';
import { buildFixPrompt, buildLocalFixPrompt } from '../../dev/buildFixPrompt';
import { BuildFailureAnalysis } from '../../dev/buildFailureClassification';
import { registerRunKind, startRun, cancelRun, retryRun, emitEvent, INTERRUPTED_ERROR } from '../engine';
import { startDevCycleRun } from './devCycleRun';
import { RunDefinition, StepEntry } from '../types';
import {
  DEV_CYCLE_SUBJECT_KIND,
  DevCycleBaseState,
  FailedBuild,
  LocalFailure,
  applyStep,
  buildAndTestStep,
  cycleOf,
  dispatchClaudeChange,
  ensureCycleWorktree,
  getLatestDevCycleRun,
  parentRunOfFixes,
  pushStep,
  startPrDraftAfterGreenBuild,
  verifyLocallyStep,
} from './devCycleSteps';

export const DEV_CYCLE_FIX_RUN_KIND = 'dev_cycle_fix';

/** Rounds of "fix → push → rebuild" the cycle tries on its own before leaving the red build to the developer. */
export const MAX_FIX_ROUNDS = 3;

/** What a fix round fixes: a red Jenkins build, or a failure of Speako's own local gate (never pushed). Exactly one is set. */
export interface FixSource {
  failedBuild?: FailedBuild;
  localFailure?: LocalFailure;
}

export interface DevCycleFixRunState extends DevCycleBaseState {
  source: FixSource;
  round: number;
  fixRequestId?: number;
}

/** Jenkins' test report for the build, reduced to the named tests' failure messages and stack-trace heads — appended to the fix prompt. Empty when the report is unavailable. */
async function describeTestFailures(jobPath: string, buildNumber: number, tests: string[]): Promise<string> {
  const report = await getTestReport(jobPath, buildNumber).catch(() => null);
  if (!report) return '';
  const wanted = new Set(tests);
  const failures = report.failures.filter((f) => !wanted.size || wanted.has(`${f.className}.${f.name}`));
  if (!failures.length) return '';
  const sections = failures.map((f) => {
    // The exception line, every "Caused by", and the project's own frames —
    // a Spring/Hibernate trace is dozens of framework frames before the first
    // com.gtechna one (seen live), and those are the ones that locate the bug.
    const traceLines = (f.errorStackTrace ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const trace = traceLines.filter((l, i) => i === 0 || /^Caused by/.test(l) || /com\.gtechna|com\.gti\./.test(l)).slice(0, 16).join('\n');
    return `### ${f.className}.${f.name}\nMessage: ${(f.errorDetails ?? '(none)').trim().slice(0, 600)}\n${trace ? `Stack trace (head):\n${trace}` : ''}`;
  });
  return `\n\nJenkins test report for build #${buildNumber} — the failing tests, as reported:\n\n${sections.join('\n\n')}\n\nYou cannot run these integration tests here (they need the automation database); reason from the messages and stack traces above and from the code.`;
}

function describeSource(source: FixSource): string {
  if (source.localFailure) return `local gate: ${source.localFailure.summary}`;
  if (source.failedBuild) return `build #${source.failedBuild.buildNumber}`;
  return 'unknown failure';
}

/**
 * The build-fix loop: a red build on the cycle's branch — or a failure of
 * the local gate before the push — starts one of these (from the main run's
 * finalize, or from a previous round's). The failure evidence (Jenkins'
 * classification + test report, or the local build output) feeds a scoped
 * fix agent, the fix diff waits for the human's approval, is committed, goes
 * through the local gate again, is pushed, and the branch is built again. A
 * still-red result starts the next round, up to MAX_FIX_ROUNDS; green drafts
 * the PR like the main pipeline would have.
 */
function steps(): StepEntry<DevCycleFixRunState>[] {
  return [
    {
      key: 'analyze_failure',
      label: 'Analyze the failure',
      async run(ctx) {
        const { source } = ctx.state;
        if (source.localFailure) {
          ctx.log(`Local gate failed: ${source.localFailure.summary}`);
          if (source.localFailure.failingTests.length) ctx.log(`Failing tests: ${source.localFailure.failingTests.join(', ')}`);
          return source.localFailure.summary;
        }
        if (!source.failedBuild) throw new Error('Nothing to fix — no failed build or local failure recorded.');
        const { jobPath, buildNumber } = source.failedBuild;
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
        if (source.failedBuild.newFailures.length) ctx.log(`New failing tests: ${source.failedBuild.newFailures.join(', ')}`);
        return `${analysis.category}: ${analysis.summary}`;
      },
    },
    {
      key: 'fix',
      label: 'Fix (Claude)',
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const { source } = ctx.state;
        const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
        let prompt: string;
        let what: string;
        if (source.localFailure) {
          prompt = buildLocalFixPrompt({ branch: cycle.branchName!, ticketKey: cycle.ticketKey, ...source.localFailure });
          what = source.localFailure.failingTests.length ? `${source.localFailure.failingTests.length} failing test(s)` : 'the local build failure';
        } else {
          const { jobPath, buildNumber, newFailures } = source.failedBuild!;
          const build = getJenkinsBuildByJobAndNumber(jobPath, buildNumber) as JenkinsBuildRow;
          const analysis = build.classificationJson as BuildFailureAnalysis;
          // The verdict's own list of new failures is the ground truth for what
          // this branch broke — more precise than the classifier's suspects.
          const suspectTests = newFailures.length ? newFailures : analysis.suspectTests;
          // The agent can't run the integration suite itself (it needs the
          // automation DB), so it gets what Jenkins saw: each new failure's
          // message and stack-trace head. Without it a fix agent concluded "send
          // me the surefire output for those three tests" and changed nothing
          // (seen live, round 9).
          const evidence = await describeTestFailures(jobPath, buildNumber, suspectTests);
          prompt = buildFixPrompt({ branch: cycle.branchName!, buildNumber, analysis: { ...analysis, suspectTests }, ticketKey: cycle.ticketKey }) + evidence;
          what = suspectTests.length ? `${suspectTests.length} failing test(s)` : 'the failure';
        }
        ctx.log(`Fix round ${ctx.state.round} (${describeSource(source)}): asking Claude to fix ${what}…`);
        const outcome = await dispatchClaudeChange(ctx, cycle, prompt, worktreePath, 'jenkins_fix');
        ctx.state.fixRequestId = outcome.request.id;
        if (outcome.status !== 'ready') throw new Error(outcome.error ?? 'The fix agent produced no change.');
        ctx.log('Fix ready for review — approve to commit, verify, push and rebuild.');
        return 'Fix ready for review.';
      },
    },
    applyStep<DevCycleFixRunState>({
      key: 'apply_fix',
      label: 'Apply fix',
      request: (state) => (state.fixRequestId ? getCodeChangeRequest(state.fixRequestId) : undefined),
      commitMessage: (cycle, _summary, state) => (state.source.failedBuild ? `${cycle.ticketKey} fix failing tests (build #${state.source.failedBuild.buildNumber})` : `${cycle.ticketKey} fix failing tests`),
    }),
    verifyLocallyStep<DevCycleFixRunState>(),
    pushStep<DevCycleFixRunState>({ request: (state) => (state.fixRequestId ? getCodeChangeRequest(state.fixRequestId) : undefined) }),
    buildAndTestStep<DevCycleFixRunState>(),
  ];
}

export const devCycleFixRunDefinition: RunDefinition<DevCycleFixRunState> = {
  kind: DEV_CYCLE_FIX_RUN_KIND,
  steps,
  async finalize(run, outcome, error) {
    const parent = parentRunOfFixes(run.state.cycleId);
    if (outcome === 'done') {
      // A fix for a review-feedback round's failure: the round itself still
      // has its replies to post (and the build it skipped), so it resumes
      // from where it failed; the main pipeline's green build drafts the PR.
      if (parent?.kind === 'pr_feedback' && parent.status === 'failed') retryRun(parent.id);
      else await startPrDraftAfterGreenBuild(run.state.cycleId);
      return;
    }
    if (outcome !== 'failed' || error === INTERRUPTED_ERROR) return;
    // The agent looked and changed nothing: the failure is not in the code
    // as far as it can tell (seen live: a gate that could not start its test
    // runner). Re-enter the gate / rebuild rather than stop — if it fails
    // again, the next round's number keeps the loop bounded.
    if (run.currentStep === 'fix' && /finished with no file changes/.test(error ?? '')) {
      console.log(`[dev-cycle] cycle ${run.state.cycleId}: fix round ${run.state.round} found nothing to fix — re-running the ${run.state.source.localFailure ? 'local gate' : 'build'}.`);
      if (parent?.kind === 'pr_feedback' && parent.status === 'failed') retryRun(parent.id, { fixRoundBase: run.state.round });
      else await startDevCycleRun(run.state.cycleId, { completedThrough: run.state.source.localFailure ? 'apply' : 'push', fixRoundBase: run.state.round });
      return;
    }
    const next: FixSource | null = run.state.localFailure ? { localFailure: run.state.localFailure } : run.state.failedBuild ? { failedBuild: run.state.failedBuild } : null;
    if (next) await startFixRoundIfPossible(run.state.cycleId, next, run.state.round + 1);
  },
  resumeOnRestart: true,
};

registerRunKind(devCycleFixRunDefinition);

/** Starts a fix round for a failure, cancelling any run still in flight for the cycle. */
export async function startDevCycleFixRun(cycleId: number, source: FixSource, round = 1): Promise<Run<DevCycleFixRunState>> {
  const previous = getLatestDevCycleRun(cycleId);
  if (previous && !TERMINAL_RUN_STATUSES.includes(previous.status)) await cancelRun(previous.id);
  return startRun<DevCycleFixRunState>({
    kind: DEV_CYCLE_FIX_RUN_KIND,
    subjectKind: DEV_CYCLE_SUBJECT_KIND,
    subjectId: String(cycleId),
    state: { cycleId, source, round },
  });
}

/**
 * The automatic follow-up to a failure: another round while rounds remain
 * and the failure is something a code fix can address (a local compile or
 * unit-test failure always is; a Jenkins failure per its classification).
 * Anything else — infra, flaky, rounds exhausted — stays failed for the
 * developer, with the reason in the server log.
 */
export async function startFixRoundIfPossible(cycleId: number, source: FixSource, round: number): Promise<Run<DevCycleFixRunState> | null> {
  if (round > MAX_FIX_ROUNDS) {
    console.log(`[dev-cycle] cycle ${cycleId}: still failing (${describeSource(source)}) after ${MAX_FIX_ROUNDS} fix rounds — leaving it to the developer.`);
    return null;
  }
  if (!getDevCycle(cycleId)) return null;
  if (source.failedBuild) {
    const build = getJenkinsBuildByJobAndNumber(source.failedBuild.jobPath, source.failedBuild.buildNumber);
    const analysis = build?.classificationJson as BuildFailureAnalysis | null | undefined;
    if (analysis && !analysis.fixable) {
      console.log(`[dev-cycle] cycle ${cycleId}: build #${source.failedBuild.buildNumber} failed with ${analysis.category} — no automatic fix round.`);
      return null;
    }
  } else if (!source.localFailure) {
    return null;
  }
  return startDevCycleFixRun(cycleId, source, round);
}

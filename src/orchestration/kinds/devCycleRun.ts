import { getJiraIssueDetail } from '../../integrations/jiraMcp';
import { runClaudeCodeReview } from '../../integrations/claudeCodeCli';
import { runSecondOpinionReview, runAntigravityAgent, isAntigravityCliConfigured, getWorktreeDiffSinceBase } from '../../integrations/antigravityCli';
import { createTicketBranchWorktree, addWorktreeForExistingBranch } from '../../integrations/gitBranches';
import { gatherJiraImplementContext } from '../../dev/jiraImplementContext';
import { buildPlanPrompt, mergeDevPlans, DEV_PLAN_JSON_SCHEMA, StructuredDevPlan, DevPlanSeedContext } from '../../dev/devPlan';
import { mergeImplementations } from '../../dev/mergeImplementations';
import { buildBranchName } from '../../dev/branchNaming';
import { startDraft } from '../../drafts/draftService';
import { lifecycleTransitionSubjectId } from '../../drafts/kinds/jiraTransitionDraft';
import { createCodeChangeRequest, getLatestCodeChangeRequestForDevCycleOrigin, markCodeChangeReady } from '../../storage/codeChangeRequestRepository';
import {
  createDevCycleImplementation,
  getDevCycleImplementationsForCycle,
  markDevCycleImplementationReady,
  markDevCycleImplementationFailed,
} from '../../storage/devCycleImplementationRepository';
import { DevCycle, setDevCycleAnalysisContext, setDevCyclePlans, setDevCycleBranch, setDevCycleWorktrees, setDevCycleCurrentStep } from '../../storage/devCycleRepository';
import { getRunLog, Run, TERMINAL_RUN_STATUSES } from '../../storage/runRepository';
import { registerRunKind, startRun, retryRun, cancelRun, approveRun, logRun, RunResume } from '../engine';
import { RunDefinition, StepContext, StepEntry } from '../types';
import {
  DEV_CYCLE_SUBJECT_KIND,
  DevCycleBaseState,
  applyStep,
  buildAndTestStep,
  pushStep,
  verifyLocallyStep,
  cycleOf,
  devCycleCommitMessage,
  dispatchClaudeChange,
  getLatestDevCycleRun,
  startPrDraftAfterGreenBuild,
} from './devCycleSteps';
import { startFixRoundIfPossible, DEV_CYCLE_FIX_RUN_KIND } from './devCycleFixRun';

export { isClaudeTuiNoise, devCycleCommitMessage, getLatestDevCycleRun } from './devCycleSteps';

export const DEV_CYCLE_RUN_KIND = 'dev_cycle';

const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
const BRANCH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Everything a dev cycle produces (context, plans, branch, worktrees,
 * implementations, merged diff) lives on the dev_cycles row and its side
 * tables, not in run state — so a retry or a manual "rerun from step X"
 * (startDevCycleRun's resume) can start a fresh run that simply skips the
 * steps whose results are already in the database. The plan prompt's seed
 * is the one exception: it's only ever needed by the plan step, so it
 * rides along in state from analyze.
 */
export interface DevCycleRunState extends DevCycleBaseState {
  seed?: DevPlanSeedContext;
}

type ImplementationOutcome = { status: 'ready' | 'failed'; diff: string | null; error: string | null };

const STEP_KEYS = ['analyze', 'plan', 'branch_and_worktrees', 'implement', 'merge_and_review', 'apply', 'verify_locally', 'push', 'build_and_test'] as const;
export type DevCycleStepKey = (typeof STEP_KEYS)[number];

function implementPromptFor(cycle: DevCycle, approvedPlan: StructuredDevPlan): string {
  return `Implement Jira ticket ${cycle.ticketKey} following this approved plan exactly. If you must deviate from it, make the minimum necessary change and clearly state the deviation in your final message.

Plan:
${JSON.stringify(approvedPlan, null, 2)}`;
}

async function runClaudeImplementation(ctx: StepContext<DevCycleRunState>, cycle: DevCycle, prompt: string, worktreePath: string): Promise<ImplementationOutcome> {
  try {
    const outcome = await dispatchClaudeChange(ctx, cycle, prompt, worktreePath, 'dev_cycle_implement');
    const implementationRow = createDevCycleImplementation({
      devCycleId: cycle.id,
      round: cycle.round,
      variant: 'claude',
      worktreePath,
      codeChangeRequestId: outcome.request.id,
      cliSessionId: outcome.request.cliSessionId,
    });
    if (outcome.status === 'ready') {
      markDevCycleImplementationReady(implementationRow.id, outcome.diff ?? '');
      ctx.log('Claude Code implementation ready.');
      return { status: 'ready', diff: outcome.diff ?? '', error: null };
    }
    markDevCycleImplementationFailed(implementationRow.id, outcome.error ?? 'Claude Code implementation failed.');
    ctx.log(`Claude Code implementation failed: ${outcome.error}`);
    return { status: 'failed', diff: null, error: outcome.error };
  } catch (err: any) {
    ctx.log(`Claude Code implementation failed to start: ${err.message}`);
    return { status: 'failed', diff: null, error: err.message };
  }
}

/**
 * Antigravity (agy) runs to completion on its own — no PID tracking.
 * runAntigravityAgent's push block + getWorktreeDiffSinceBase are the
 * safety net documented in antigravityCli.ts (accept-edits mode isn't
 * confirmed to block `git commit` the way Claude Code is). When agy is
 * missing or fails this variant is simply failed and the implement step
 * proceeds with Claude's.
 */
async function runAntigravityImplementation(ctx: StepContext<DevCycleRunState>, cycle: DevCycle, prompt: string, worktreePath: string): Promise<ImplementationOutcome> {
  if (!isAntigravityCliConfigured()) {
    const error = 'Antigravity CLI (agy) is not installed.';
    ctx.log(error);
    return { status: 'failed', diff: null, error };
  }
  const implementationRow = createDevCycleImplementation({ devCycleId: cycle.id, round: cycle.round, variant: 'gemini', worktreePath, cliSessionId: 'antigravity' });
  try {
    const result = await runAntigravityAgent(prompt, worktreePath, { mode: 'accept-edits', onProgress: (message) => ctx.log(`Antigravity: ${message}`) });
    if (!result.isError) {
      const diff = await getWorktreeDiffSinceBase(worktreePath, `origin/${cycle.baseBranch}`);
      if (diff.trim()) {
        markDevCycleImplementationReady(implementationRow.id, diff);
        ctx.log('Antigravity implementation ready.');
        return { status: 'ready', diff, error: null };
      }
      const error = 'Antigravity implementation agent produced no file changes.';
      markDevCycleImplementationFailed(implementationRow.id, error);
      ctx.log(error);
      return { status: 'failed', diff: null, error };
    }
    const error = result.resultText.slice(0, 300);
    markDevCycleImplementationFailed(implementationRow.id, error);
    ctx.log(`Antigravity implementation failed: ${error}`);
    return { status: 'failed', diff: null, error };
  } catch (err: any) {
    markDevCycleImplementationFailed(implementationRow.id, err.message);
    ctx.log(`Antigravity implementation errored: ${err.message}`);
    return { status: 'failed', diff: null, error: err.message };
  }
}

/** Each variant's latest 'ready' implementation for the cycle's current round — what the merge step reconciles, and what a retry of implement reuses instead of re-running that agent. */
function readyImplementations(cycle: DevCycle) {
  const rows = getDevCycleImplementationsForCycle(cycle.id, cycle.round);
  return { claude: rows.find((i) => i.variant === 'claude' && i.status === 'ready'), gemini: rows.find((i) => i.variant === 'gemini' && i.status === 'ready') };
}

function approvedPlanOf(cycle: DevCycle): StructuredDevPlan {
  const plan = cycle.planMerged ?? cycle.planClaude;
  if (!plan) throw new Error('No approved plan.');
  return plan;
}

/**
 * The Jira-implement pipeline as a run: analyze and plan run unattended;
 * the run parks for the human's plan approval; branch creation, both
 * implementations and the AI merge run straight through to a merged diff;
 * the run parks again for the human's diff approval; then the diff is
 * committed, compiled and unit-tested locally (the gate before anything
 * leaves the machine), pushed, and built and tested on the shared Jenkins
 * job. A green build ends the run (finalize drafts the PR); a failed local
 * gate or a red build with a fixable classification starts a fix round
 * (devCycleFixRun.ts) instead of leaving the cycle to the developer.
 */
function steps(): StepEntry<DevCycleRunState>[] {
  return [
    {
      key: 'analyze',
      label: 'Gather ticket context',
      timeoutMs: ANALYZE_TIMEOUT_MS,
      async run(ctx) {
        const cycle = cycleOf(ctx);
        ctx.log(`Gathering context for ${cycle.ticketKey}…`);
        const { seed, context } = await gatherJiraImplementContext(cycle.ticketKey, cycle.repoName);
        setDevCycleAnalysisContext(cycle.id, context);
        ctx.state.seed = seed;
        setDevCycleCurrentStep(cycle.id, 'plan');
        return `${context.confluencePages.length} Confluence page(s), ${context.codeHits.length} code hit(s), ${context.relatedPrs.length} related PR(s).`;
      },
    },
    {
      key: 'plan',
      label: 'Plan (Claude + Antigravity)',
      async run(ctx) {
        const cycle = cycleOf(ctx);
        if (!ctx.state.seed) {
          // A resumed run whose analyze step was kept — re-gather just the seed.
          ctx.state.seed = (await gatherJiraImplementContext(cycle.ticketKey, cycle.repoName)).seed;
        }
        const secondOpinionEnabled = isAntigravityCliConfigured();
        ctx.log(secondOpinionEnabled ? 'Running Claude Code planning, plus an Antigravity second opinion, in parallel…' : 'Running Claude Code planning…');
        const prompt = buildPlanPrompt(ctx.state.seed);
        const [claudeResult, secondOpinion] = await Promise.all([
          runClaudeCodeReview(prompt, cycle.repoPath, {
            jsonSchema: DEV_PLAN_JSON_SCHEMA,
            model: 'opus',
            onProgress: (message) => {
              ctx.log(message);
              ctx.detail(message);
            },
          }),
          secondOpinionEnabled ? runSecondOpinionReview(prompt, cycle.repoPath, (message) => ctx.log(`Antigravity: ${message}`)) : Promise.resolve(null),
        ]);
        if (claudeResult.isError || !claudeResult.structuredOutput) throw new Error(claudeResult.resultText || 'Claude Code did not return a usable plan.');
        const claudePlan = claudeResult.structuredOutput as StructuredDevPlan;
        // Antigravity has no --json-schema equivalent — its solo plan is kept
        // as free text in `understanding` purely for side-by-side display;
        // the structured shape only ever comes from the merge pass.
        const secondOpinionText = secondOpinion && !secondOpinion.isError ? secondOpinion.resultText : null;
        const geminiPlanForDisplay: StructuredDevPlan | null = secondOpinionText
          ? { understanding: secondOpinionText, approach: '', files: [], tests: [], risks: [], openQuestions: [], estimatedSize: 'm' }
          : null;
        let mergedPlan = claudePlan;
        if (secondOpinionText) {
          ctx.log('Merging the Claude Code plan and the Antigravity second opinion…');
          try {
            mergedPlan = await mergeDevPlans(claudePlan, secondOpinionText);
          } catch (err: any) {
            ctx.log(`Could not merge the Antigravity plan — keeping the Claude Code plan only: ${err.message}`);
          }
        }
        setDevCyclePlans(cycle.id, { claude: claudePlan, gemini: geminiPlanForDisplay, merged: mergedPlan });
        ctx.log('Plan ready for review — approve to continue.');
        return mergedPlan.understanding;
      },
    },
    {
      key: 'branch_and_worktrees',
      label: 'Create branch & worktrees',
      approval: true,
      timeoutMs: BRANCH_TIMEOUT_MS,
      // Idempotent: reuses whatever already exists on the cycle, so a retry
      // after a partial failure (branch created, second worktree failed)
      // doesn't try to recreate a branch that's already there.
      async run(ctx) {
        const cycle = cycleOf(ctx);
        let { branchName, worktreePath } = cycle;
        if (branchName && worktreePath) {
          ctx.log(`Branch "${branchName}" already exists — reusing it.`);
        } else {
          const ticket = await getJiraIssueDetail(cycle.ticketKey).catch(() => null);
          branchName = buildBranchName({ type: cycle.branchType, ticketKey: cycle.ticketKey, summary: ticket?.summary || cycle.ticketKey });
          ctx.log(`Creating branch "${branchName}"…`);
          const created = await createTicketBranchWorktree(cycle.repoPath, branchName, cycle.baseBranch);
          worktreePath = created.worktreePath;
          if (created.reusedExisting) ctx.log(`Branch "${branchName}" already existed — reusing it (and whatever is already committed on it).`);
          setDevCycleBranch(cycle.id, { branchName, worktreePath });
          // "Branch created + implementation starts" is the one approval — the
          // Jira write itself is still its own separately-gated draft.
          startDraft({ kind: 'jira_transition', subjectId: lifecycleTransitionSubjectId(cycle.id, 'In Progress') }).catch((err: any) => {
            console.error(`[dev-cycle] failed to auto-start the Dev Ready -> In Progress transition for cycle ${cycle.id}:`, err.message);
          });
        }
        if (cycle.worktreePathGemini) {
          ctx.log('Antigravity worktree already exists — reusing it.');
        } else {
          ctx.log('Creating a second worktree for the Antigravity implementation…');
          setDevCycleWorktrees(cycle.id, { worktreePathGemini: await addWorktreeForExistingBranch(cycle.repoPath, branchName, 'gemini') });
        }
        return `Branch "${branchName}", 2 worktrees.`;
      },
    },
    {
      key: 'implement',
      label: 'Implement (Claude + Antigravity)',
      // Idempotent per variant: a variant already 'ready' for this round is
      // reused rather than re-dispatched, so a retry after only one agent
      // failed re-runs just that one.
      async run(ctx) {
        const cycle = cycleOf(ctx);
        if (!cycle.worktreePath || !cycle.worktreePathGemini) throw new Error('This cycle has no worktrees to implement in.');
        setDevCycleCurrentStep(cycle.id, 'implement');
        const approvedPlan = approvedPlanOf(cycle);
        const existing = readyImplementations(cycle);
        const prompt = implementPromptFor(cycle, approvedPlan);
        ctx.log(
          existing.claude || existing.gemini
            ? 'Retrying the implementation — reusing whichever agent already succeeded, re-running only the one that failed…'
            : 'Starting the Claude Code and Antigravity implementations in parallel — both implement the same approved plan independently, in their own worktree…'
        );
        const [claude, gemini] = await Promise.all([
          existing.claude ? Promise.resolve<ImplementationOutcome>({ status: 'ready', diff: existing.claude.diff, error: null }) : runClaudeImplementation(ctx, cycle, prompt, cycle.worktreePath),
          existing.gemini ? Promise.resolve<ImplementationOutcome>({ status: 'ready', diff: existing.gemini.diff, error: null }) : runAntigravityImplementation(ctx, cycle, prompt, cycle.worktreePathGemini),
        ]);
        if (claude.status === 'failed' && gemini.status === 'failed') throw new Error(`Both implementations failed. Claude: ${claude.error}. Antigravity: ${gemini.error}.`);
        return claude.status === 'ready' && gemini.status === 'ready' ? 'Both implementations ready.' : `Only ${claude.status === 'ready' ? 'Claude' : 'Antigravity'}'s implementation succeeded — proceeding with it alone.`;
      },
    },
    {
      key: 'merge_and_review',
      label: 'Merge & review',
      // Reconciles the two implementations (or carries the sole survivor
      // forward) into one merged diff for the human's final review.
      async run(ctx) {
        const cycle = cycleOf(ctx);
        if (!cycle.worktreePath) throw new Error('This cycle has no worktree to merge in.');
        setDevCycleCurrentStep(cycle.id, 'merge_and_review');
        const approvedPlan = approvedPlanOf(cycle);
        const { claude, gemini } = readyImplementations(cycle);
        if (!claude && !gemini) throw new Error('No ready implementation to merge.');
        let mergedDiff: string;
        let mergeNote: string;
        if (claude && gemini) {
          ctx.log('Reconciling both implementations into one merged diff…');
          try {
            const merged = await mergeImplementations(approvedPlan, claude.diff!, gemini.diff!, cycle.baseBranch, cycle.worktreePath, (message) => ctx.log(`Merge: ${message}`));
            mergedDiff = merged.mergedDiff;
            mergeNote = merged.reconciliationNotes;
          } catch (err: any) {
            ctx.log(`Could not reconcile the two implementations — falling back to Claude's implementation only: ${err.message}`);
            mergedDiff = claude.diff!;
            mergeNote = "Merge failed — this is Claude's implementation, unmodified.";
          }
        } else {
          mergedDiff = (claude?.diff ?? gemini?.diff)!;
          mergeNote = `Only ${claude ? 'Claude' : 'Antigravity'}'s implementation succeeded — no comparison was possible.`;
        }
        const mergeRequest = createCodeChangeRequest({
          taskId: cycle.taskId ?? undefined,
          devCycleId: cycle.id,
          origin: 'dev_cycle_merge',
          repoName: cycle.repoName,
          repoPath: cycle.worktreePath,
          cliSessionId: `dev-cycle-merge-${cycle.id}-${cycle.round}-${Date.now()}`,
        });
        markCodeChangeReady(mergeRequest.id, cycle.worktreePath, mergedDiff);
        ctx.log(`Merge notes: ${mergeNote}`);
        ctx.log('Merged diff ready for review — approve to apply, or request changes.');
        return 'Merged diff ready for review.';
      },
    },
    applyStep<DevCycleRunState>({
      key: 'apply',
      label: 'Apply merged diff',
      request: (state) => getLatestCodeChangeRequestForDevCycleOrigin(state.cycleId, 'dev_cycle_merge'),
      commitMessage: (cycle, summary) => devCycleCommitMessage(cycle.ticketKey, summary),
    }),
    verifyLocallyStep<DevCycleRunState>(),
    pushStep<DevCycleRunState>({ request: (state) => getLatestCodeChangeRequestForDevCycleOrigin(state.cycleId, 'dev_cycle_merge') }),
    buildAndTestStep<DevCycleRunState>(),
  ];
}

export const devCycleRunDefinition: RunDefinition<DevCycleRunState> = {
  kind: DEV_CYCLE_RUN_KIND,
  steps,
  async finalize(run, outcome) {
    if (outcome === 'done') {
      await startPrDraftAfterGreenBuild(run.state.cycleId);
      return;
    }
    // A red build, or a failed local gate, hands over to the fix loop; every other failure waits for Retry.
    if (outcome === 'failed' && run.state.localFailure) await startFixRoundIfPossible(run.state.cycleId, { localFailure: run.state.localFailure }, 1);
    else if (outcome === 'failed' && run.state.failedBuild) await startFixRoundIfPossible(run.state.cycleId, { failedBuild: run.state.failedBuild }, 1);
  },
};

registerRunKind(devCycleRunDefinition);

/** Steps up to and including `through`, for a resume that starts the run at the step after it. */
export function devCycleStepsThrough(through: DevCycleStepKey): DevCycleStepKey[] {
  return STEP_KEYS.slice(0, STEP_KEYS.indexOf(through) + 1);
}

/** The human gates across the cycle's run kinds; a resume that already includes a gate's step implies its approval, since that step only ever ran after a human approved. */
const GATE_STEPS = ['branch_and_worktrees', 'apply', 'apply_fix'] as const;
export type DevCycleGate = (typeof GATE_STEPS)[number];

/**
 * Starts a run for the cycle, cancelling one still in flight first — a
 * manual rerun/redo supersedes whatever was happening. `resume` lists the
 * steps whose results are already on the cycle (see GATE_STEPS for the
 * implied approvals). Resuming through 'plan' still parks for the plan
 * approval; through 'merge_and_review' still parks for the diff approval.
 */
export async function startDevCycleRun(cycleId: number, resume?: { completedThrough: DevCycleStepKey }): Promise<Run<DevCycleRunState>> {
  const previous = getLatestDevCycleRun(cycleId);
  if (previous && !TERMINAL_RUN_STATUSES.includes(previous.status)) await cancelRun(previous.id);
  const completed = resume ? devCycleStepsThrough(resume.completedThrough) : [];
  const resumeSpec: RunResume | undefined = resume ? { completed, approved: GATE_STEPS.filter((g) => (completed as string[]).includes(g)) } : undefined;
  return startRun<DevCycleRunState>({ kind: DEV_CYCLE_RUN_KIND, subjectKind: DEV_CYCLE_SUBJECT_KIND, subjectId: String(cycleId), state: { cycleId }, resume: resumeSpec });
}

/** Retries the cycle's latest run (main pipeline or fix round) from its failed step (see engine.ts's retryRun). Null when there's nothing finished to retry. */
export function retryDevCycleRun(cycleId: number): Run | null {
  const latest = getLatestDevCycleRun(cycleId);
  return latest ? retryRun(latest.id) : null;
}

/** The gate the cycle's run is parked on, if any — what the approve/refine routes and the Diff tab check. */
export function devCycleAwaitingGate(cycleId: number): DevCycleGate | null {
  const run = getLatestDevCycleRun(cycleId);
  if (!run || run.status !== 'waiting_approval') return null;
  return GATE_STEPS.find((g) => g === run.currentStep) ?? null;
}

export function isDevCycleAwaitingPlanApproval(cycleId: number): boolean {
  return devCycleAwaitingGate(cycleId) === 'branch_and_worktrees';
}

/** True while a diff (the merged implementation, or a fix round's change) waits for the human — both land through the same approve. */
export function isDevCycleAwaitingChangeApproval(cycleId: number): boolean {
  const gate = devCycleAwaitingGate(cycleId);
  return gate === 'apply' || gate === 'apply_fix';
}

/** Resumes the run from whichever gate it's parked on (the routes check which one first). */
export function approveDevCycleGate(cycleId: number): boolean {
  const run = getLatestDevCycleRun(cycleId);
  return !!run && approveRun(run.id);
}

export function logDevCycle(cycleId: number, message: string): void {
  const run = getLatestDevCycleRun(cycleId);
  if (run) logRun(run.id, message);
}

/** What the Jira-implement tab needs to know about the cycle's current run beyond its steps: which kind it is (a fix round shows as such), its status, and the step it's parked on or failed at. */
export interface DevCycleRunSummary {
  id: number;
  kind: string;
  status: Run['status'];
  currentStep: string | null;
  error: string | null;
  /** Fix rounds only. */
  fixRound: number | null;
  awaitingGate: DevCycleGate | null;
}

export function devCycleRunSummary(cycleId: number): DevCycleRunSummary | null {
  const run = getLatestDevCycleRun<any>(cycleId);
  if (!run) return null;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    currentStep: run.currentStep,
    error: run.error,
    fixRound: run.kind === DEV_CYCLE_FIX_RUN_KIND ? run.state.round ?? null : null,
    awaitingGate: devCycleAwaitingGate(cycleId),
  };
}

/** The cycle as GET /api/jira-implement/:id returns it — phases/log read from its latest run (index.html's renderJiraImplement shape); cycles that predate runs keep their own columns. */
export function devCycleView(cycle: DevCycle): DevCycle {
  const run = getLatestDevCycleRun(cycle.id);
  if (!run) return cycle;
  return { ...cycle, phases: run.steps, log: getRunLog(run.id) };
}

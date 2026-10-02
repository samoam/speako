import { config } from '../../config';
import { getJiraIssueDetail } from '../../integrations/jiraMcp';
import { startClaudeCodeTask, getBackgroundTaskLogs, runClaudeCodeReview, applyCodeChangeToRepo, pushRepoChanges, git } from '../../integrations/claudeCodeCli';
import { jobPathFor, getTestReport, getRecentBuilds } from '../../integrations/jenkinsClient';
import { assessUnstableBuild } from '../../dev/buildVerdict';
import { pollJenkinsBuilds } from '../../dev/jenkinsMonitor';
import { triggerJenkinsBuild, getQueueState, getBuildByNumber } from '../../integrations/jenkinsMcp';
import { createJenkinsBuildRequest, markJenkinsBuildRequestStarted } from '../../storage/jenkinsBuildRequestRepository';
import { runSecondOpinionReview, runAntigravityAgent, isAntigravityCliConfigured, getWorktreeDiffSinceBase, LEGACY_NO_PUSH_URL } from '../../integrations/antigravityCli';
import { createTicketBranchWorktree, addWorktreeForExistingBranch } from '../../integrations/gitBranches';
import { pollCodeChangeRequest } from '../../integrations/codeChangePoller';
import { gatherJiraImplementContext } from '../../dev/jiraImplementContext';
import { buildPlanPrompt, mergeDevPlans, DEV_PLAN_JSON_SCHEMA, StructuredDevPlan, DevPlanSeedContext } from '../../dev/devPlan';
import { mergeImplementations } from '../../dev/mergeImplementations';
import { buildBranchName } from '../../dev/branchNaming';
import { startDraft } from '../../drafts/draftService';
import { lifecycleTransitionSubjectId } from '../../drafts/kinds/jiraTransitionDraft';
import {
  createCodeChangeRequest,
  getCodeChangeRequest,
  getLatestCodeChangeRequestForDevCycleOrigin,
  markCodeChangeReady,
  markCodeChangeApplied,
  markCodeChangePushed,
} from '../../storage/codeChangeRequestRepository';
import {
  createDevCycleImplementation,
  getDevCycleImplementationsForCycle,
  markDevCycleImplementationReady,
  markDevCycleImplementationFailed,
} from '../../storage/devCycleImplementationRepository';
import {
  DevCycle,
  getDevCycle,
  setDevCycleAnalysisContext,
  setDevCyclePlans,
  setDevCycleBranch,
  setDevCycleWorktrees,
  setDevCycleCurrentStep,
} from '../../storage/devCycleRepository';
import { getLatestRunForSubject, getRunLog, Run, TERMINAL_RUN_STATUSES } from '../../storage/runRepository';
import { registerRunKind, startRun, retryRun, cancelRun, approveRun, logRun, emitEvent, RunResume } from '../engine';
import { RunDefinition, StepContext, StepEntry } from '../types';

export const DEV_CYCLE_RUN_KIND = 'dev_cycle';
const SUBJECT_KIND = 'dev_cycle';

const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
const BRANCH_TIMEOUT_MS = 10 * 60 * 1000;
const PUSH_TIMEOUT_MS = 10 * 60 * 1000;
/** The integration job runs the whole suite (~3,200 tests, ~20 min seen live) and may wait for an executor first. */
const BUILD_TIMEOUT_MS = 90 * 60 * 1000;
const BUILD_POLL_MS = 20_000;

/**
 * Everything a dev cycle produces (context, plans, branch, worktrees,
 * implementations, merged diff) lives on the dev_cycles row and its side
 * tables, not in run state — so a retry or a manual "rerun from step X"
 * (startDevCycleRun's resume) can start a fresh run that simply skips the
 * steps whose results are already in the database. The plan prompt's seed
 * is the one exception: it's only ever needed by the plan step, so it
 * rides along in state from analyze.
 */
export interface DevCycleRunState {
  cycleId: number;
  seed?: DevPlanSeedContext;
}

type ImplementationOutcome = { status: 'ready' | 'failed'; diff: string | null; error: string | null };

const STEP_KEYS = ['analyze', 'plan', 'branch_and_worktrees', 'implement', 'merge_and_review', 'apply_and_push', 'build_and_test'] as const;
export type DevCycleStepKey = (typeof STEP_KEYS)[number];

function cycleOf(ctx: StepContext<DevCycleRunState>): DevCycle {
  const cycle = getDevCycle(ctx.state.cycleId);
  if (!cycle) throw new Error(`Dev cycle ${ctx.state.cycleId} no longer exists.`);
  return cycle;
}

/**
 * `claude logs <id>` of a `--bg` agent includes its terminal UI, not just
 * its transcript — seen live in a run log: spinner lines ("✽ Imagining… (18s
 * · ↓ 464 tokens …)"), full-width box-drawing rules, and the status bar
 * ("⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt"). None of
 * that is progress; it's dropped before reaching the run log.
 */
export function isClaudeTuiNoise(line: string): boolean {
  if (/^[─━═│┃╌╍┄┅\s❯>]+$/u.test(line)) return true;
  if (/[─━═]{8,}/u.test(line)) return true;
  if (/^[✻✽✶✳✢·•●○◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S+…/u.test(line)) return true;
  if (/accept edits on|shift\+tab to cycle|esc to interrupt|← for agents|\?\s*for shortcuts/i.test(line)) return true;
  if (/\x1b\[/.test(line)) return true;
  return false;
}

/**
 * The commit the cycle lands on the branch: the ticket key first, then the
 * ticket's summary, one short subject line and nothing else — the team's
 * convention (no "Implement …" prefix, no body, no co-author trailer, no
 * mention of the tooling). Author/committer come from the repo's own git
 * identity, as they would for a hand-made commit.
 */
export function devCycleCommitMessage(ticketKey: string, summary: string | null | undefined): string {
  const text = (summary ?? '').replace(/\s+/g, ' ').trim();
  const subject = text ? `${ticketKey} ${text}` : ticketKey;
  return subject.length > 100 ? `${subject.slice(0, 99).trimEnd()}…` : subject;
}

function implementPromptFor(cycle: DevCycle, approvedPlan: StructuredDevPlan): string {
  return `Implement Jira ticket ${cycle.ticketKey} following this approved plan exactly. If you must deviate from it, make the minimum necessary change and clearly state the deviation in your final message.

Plan:
${JSON.stringify(approvedPlan, null, 2)}`;
}

async function runClaudeImplementation(ctx: StepContext<DevCycleRunState>, cycle: DevCycle, prompt: string, worktreePath: string): Promise<ImplementationOutcome> {
  try {
    const { cliSessionId } = await startClaudeCodeTask(prompt, worktreePath, 'sonnet');
    const codeChangeRequest = createCodeChangeRequest({
      taskId: cycle.taskId ?? undefined,
      devCycleId: cycle.id,
      origin: 'dev_cycle_implement',
      repoName: cycle.repoName,
      repoPath: worktreePath,
      cliSessionId,
    });
    const implementationRow = createDevCycleImplementation({
      devCycleId: cycle.id,
      round: cycle.round,
      variant: 'claude',
      worktreePath,
      codeChangeRequestId: codeChangeRequest.id,
      cliSessionId,
    });
    // Tails `claude logs <id>` alongside pollCodeChangeRequest's coarse
    // state polling — `--bg` has no equivalent of runClaudeCodeReview's
    // streaming onProgress, so this is the only way to show what the agent
    // is doing rather than "Agent state: running" for however long it takes.
    let tailingStopped = false;
    let lastLoggedLength = 0;
    const tail = (async () => {
      while (!tailingStopped) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        if (tailingStopped) return;
        try {
          const logs = await getBackgroundTaskLogs(cliSessionId);
          if (logs.length > lastLoggedLength) {
            const added = logs.slice(lastLoggedLength);
            lastLoggedLength = logs.length;
            for (const line of added.split('\n')) {
              const trimmed = line.trim();
              if (trimmed && !isClaudeTuiNoise(trimmed)) ctx.log(`Claude: ${trimmed}`);
            }
          }
        } catch {
          // best-effort only — a failed `claude logs` call shouldn't affect the actual poll/outcome
        }
      }
    })();
    await pollCodeChangeRequest(codeChangeRequest.id, emitEvent);
    tailingStopped = true;
    await tail;
    const finished = getCodeChangeRequest(codeChangeRequest.id)!;
    if (finished.status === 'ready') {
      markDevCycleImplementationReady(implementationRow.id, finished.diff ?? '');
      ctx.log('Claude Code implementation ready.');
      return { status: 'ready', diff: finished.diff ?? '', error: null };
    }
    const error = finished.error ?? 'Claude Code implementation failed.';
    markDevCycleImplementationFailed(implementationRow.id, error);
    ctx.log(`Claude Code implementation failed: ${error}`);
    return { status: 'failed', diff: null, error };
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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * The Jira-implement pipeline as a run: analyze and plan run unattended;
 * the run parks for the human's plan approval; branch creation, both
 * implementations and the AI merge run straight through to a merged diff;
 * the run parks again for the human's diff approval; then the diff is
 * applied + pushed and the branch is built and tested on the shared Jenkins
 * job, and only a green build ends the run (finalize starts the pr_open
 * draft). A red build fails the run at build_and_test — the Tests tab shows
 * the classified failure, "Propose fix" is the jenkins_fix draft, and
 * /retry re-runs just the build.
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
    {
      key: 'apply_and_push',
      label: 'Apply merged diff & push',
      approval: true,
      timeoutMs: PUSH_TIMEOUT_MS,
      // Resumable: the merge request's own status says how far a previous
      // attempt got (seen live: committed, then the push failed), so a retry
      // never re-applies an already-committed diff.
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const mergeRequest = getLatestCodeChangeRequestForDevCycleOrigin(cycle.id, 'dev_cycle_merge');
        if (!mergeRequest || !['ready', 'applied', 'pushed'].includes(mergeRequest.status) || !cycle.worktreePath || !cycle.branchName) throw new Error('No merged diff ready to apply.');
        if (mergeRequest.status === 'ready') {
          const ticket = await getJiraIssueDetail(cycle.ticketKey).catch(() => null);
          await applyCodeChangeToRepo(mergeRequest.diff ?? '', cycle.worktreePath, devCycleCommitMessage(cycle.ticketKey, ticket?.summary));
          markCodeChangeApplied(mergeRequest.id);
          emitEvent({ type: 'code-change-applied', devCycleId: cycle.id, requestId: mergeRequest.id });
        } else {
          ctx.log('Merged diff was already committed by a previous attempt.');
        }
        if (mergeRequest.status !== 'pushed') {
          // An earlier Speako version blocked Antigravity's pushes by writing
          // a bogus push URL into the shared repo config (see antigravityCli.ts);
          // a repo that still carries it can't push from any worktree.
          const pushUrl = await git(['config', '--get', 'remote.origin.pushurl'], cycle.repoPath).catch(() => '');
          if (pushUrl.trim() === LEGACY_NO_PUSH_URL) {
            await git(['config', '--unset', 'remote.origin.pushurl'], cycle.repoPath);
            ctx.log('Removed a leftover push block from an earlier Speako version from the repo config.');
          }
          await pushRepoChanges(cycle.worktreePath);
          markCodeChangePushed(mergeRequest.id);
          emitEvent({ type: 'code-change-pushed', devCycleId: cycle.id, requestId: mergeRequest.id });
        }
        // 'done' is what unlocks the PR/Docs tabs — the PR draft itself only
        // auto-starts once the build is green (finalize), but "Draft PR now"
        // stays available as the manual escape hatch.
        setDevCycleCurrentStep(cycle.id, 'done');
        ctx.log(`Merged diff applied and pushed to ${cycle.branchName}.`);
        return `Pushed to ${cycle.branchName}.`;
      },
    },
    {
      key: 'build_and_test',
      label: 'Build & test on Jenkins',
      timeoutMs: BUILD_TIMEOUT_MS,
      async run(ctx) {
        const cycle = cycleOf(ctx);
        if (!config.jenkinsTestJob) return 'Skipped — no build & test job configured (Settings > Jenkins).';
        if (!cycle.branchName) throw new Error('This cycle has no branch to build.');
        const jobFullName = config.jenkinsTestJob;
        const queueId = await triggerJenkinsBuild(jobFullName, { [config.jenkinsTestBranchParam]: cycle.branchName });
        // Recorded so jenkinsMonitor.ts follows the same build into the Tests
        // tab (build rows + failure classification); this step only waits for
        // the verdict.
        const buildRequest = createJenkinsBuildRequest({ devCycleId: cycle.id, jobPath: jobPathFor(jobFullName), jobFullName, branchName: cycle.branchName, queueId });
        ctx.log(`Queued ${jobFullName} for ${cycle.branchName} (queue item ${queueId}).`);
        let buildNumber: number | null = null;
        while (!ctx.signal.aborted) {
          if (buildNumber == null) {
            const queue = await getQueueState(queueId);
            if (queue.state === 'cancelled' || queue.state === 'gone') throw new Error(`Jenkins ${queue.state === 'cancelled' ? 'cancelled the queued build' : 'lost the queued build'} (queue item ${queueId}).`);
            if (queue.state === 'started') {
              buildNumber = queue.buildNumber;
              // The monitor follows the request from here by build number — the
              // queue item it would otherwise rely on expires minutes after this.
              markJenkinsBuildRequestStarted(buildRequest.id, buildNumber);
              ctx.log(`Build #${buildNumber} started.`);
            } else {
              ctx.detail(queue.why ? `Waiting in the Jenkins queue: ${queue.why}` : 'Waiting in the Jenkins queue…');
            }
          } else {
            const build = await getBuildByNumber(jobFullName, buildNumber);
            if (build && !build.building) {
              // Record the finished build right away (rows in jenkins_builds,
              // failure classification, the jenkins_build task "Propose fix"
              // hangs off) instead of waiting for the monitor's next tick.
              await pollJenkinsBuilds(emitEvent).catch((err: any) => ctx.log(`Could not record the build in the Tests tab yet: ${err.message}`));
              if (build.result === 'SUCCESS') {
                ctx.log(`Build #${buildNumber} passed.`);
                return `Build #${buildNumber} passed.`;
              }
              if (build.result === 'UNSTABLE') {
                // Judged against the job's own history, not "zero failures" — see buildVerdict.ts.
                const jobPath = jobPathFor(jobFullName);
                const recent = (await getRecentBuilds(jobPath, 7)).filter((b) => b.number !== buildNumber && !b.building).slice(0, 5);
                const [report, ...recentReports] = await Promise.all([getTestReport(jobPath, buildNumber), ...recent.map((b) => getTestReport(jobPath, b.number))]);
                const verdict = assessUnstableBuild(report, recentReports.filter((r): r is NonNullable<typeof r> => !!r));
                if (verdict.preexistingFailures.length) ctx.log(`Pre-existing failures (also failing before this branch): ${verdict.preexistingFailures.join(', ')}`);
                if (verdict.pass) {
                  ctx.log(`Build #${buildNumber} unstable — ${verdict.reason}; treating as passed.`);
                  return `Build #${buildNumber} unstable — ${verdict.reason}.`;
                }
                throw new Error(`Build #${buildNumber} UNSTABLE — ${verdict.reason} — ${build.url}`);
              }
              throw new Error(`Build #${buildNumber} ${build.result ?? 'ended without a result'} — ${build.url}`);
            }
            ctx.detail(`Build #${buildNumber} running…`);
          }
          await sleep(BUILD_POLL_MS, ctx.signal);
        }
        throw new Error('Cancelled while waiting for the build.');
      },
    },
  ];
}

export const devCycleRunDefinition: RunDefinition<DevCycleRunState> = {
  kind: DEV_CYCLE_RUN_KIND,
  steps,
  async finalize(run, outcome) {
    if (outcome !== 'done') return;
    // Only a green build reaches here — the PR is drafted on a tested branch.
    await startDraft({ kind: 'pr_open', subjectId: run.state.cycleId }).catch((err: any) => {
      console.error(`[dev-cycle] failed to auto-start PR open for cycle ${run.state.cycleId}:`, err.message);
    });
  },
};

registerRunKind(devCycleRunDefinition);

export function getLatestDevCycleRun(cycleId: number): Run<DevCycleRunState> | undefined {
  return getLatestRunForSubject(SUBJECT_KIND, String(cycleId)) as Run<DevCycleRunState> | undefined;
}

/** Steps up to and including `through`, for a resume that starts the run at the step after it. */
export function devCycleStepsThrough(through: DevCycleStepKey): DevCycleStepKey[] {
  return STEP_KEYS.slice(0, STEP_KEYS.indexOf(through) + 1);
}

/** The two human gates of the run; a resume that already includes a gate's step implies its approval, since that step only ever ran after a human approved. */
const GATE_STEPS: DevCycleStepKey[] = ['branch_and_worktrees', 'apply_and_push'];

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
  const resumeSpec: RunResume | undefined = resume ? { completed, approved: GATE_STEPS.filter((g) => completed.includes(g)) } : undefined;
  return startRun<DevCycleRunState>({ kind: DEV_CYCLE_RUN_KIND, subjectKind: SUBJECT_KIND, subjectId: String(cycleId), state: { cycleId }, resume: resumeSpec });
}

/** Retries the cycle's latest run from its failed step (see engine.ts's retryRun). Null when there's nothing finished to retry. */
export function retryDevCycleRun(cycleId: number): Run | null {
  const latest = getLatestDevCycleRun(cycleId);
  return latest ? retryRun(latest.id) : null;
}

/** The gate the cycle's run is parked on, if any — what the plan/merge approve+refine routes check. */
export function devCycleAwaitingGate(cycleId: number): DevCycleStepKey | null {
  const run = getLatestDevCycleRun(cycleId);
  if (!run || run.status !== 'waiting_approval') return null;
  return GATE_STEPS.find((g) => g === run.currentStep) ?? null;
}

export function isDevCycleAwaitingPlanApproval(cycleId: number): boolean {
  return devCycleAwaitingGate(cycleId) === 'branch_and_worktrees';
}

export function isDevCycleAwaitingMergeApproval(cycleId: number): boolean {
  return devCycleAwaitingGate(cycleId) === 'apply_and_push';
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

/** The cycle as GET /api/jira-implement/:id returns it — phases/log read from its latest run (index.html's renderJiraImplement shape); cycles that predate runs keep their own columns. */
export function devCycleView(cycle: DevCycle): DevCycle {
  const run = getLatestDevCycleRun(cycle.id);
  if (!run) return cycle;
  return { ...cycle, phases: run.steps, log: getRunLog(run.id) };
}

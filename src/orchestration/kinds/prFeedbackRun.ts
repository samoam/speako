import { runClaudeCodeReview } from '../../integrations/claudeCodeCli';
import { addPullRequestComment, resolvePullRequestComment, getPullRequest } from '../../integrations/bitbucketServer';
import { getCodeChangeRequest } from '../../storage/codeChangeRequestRepository';
import { getDevCycle } from '../../storage/devCycleRepository';
import { getPendingFeedback, upsertFeedbackThreads, setFeedbackTriage, markFeedbackAnswered, DevCycleFeedback } from '../../storage/devCycleFeedbackRepository';
import { Run, TERMINAL_RUN_STATUSES } from '../../storage/runRepository';
import { watchDevCyclePr, prRefOf, buildTriagePrompt, buildFeedbackChangesPrompt, TRIAGE_JSON_SCHEMA, TriageResult } from '../../dev/prFeedback';
import { registerRunKind, startRun, cancelRun } from '../engine';
import { RunDefinition, StepEntry } from '../types';
import { DEV_CYCLE_SUBJECT_KIND, DevCycleBaseState, applyStep, buildAndTestStep, cycleOf, dispatchClaudeChange, ensureCycleWorktree, getLatestDevCycleRun, pushStep, verifyLocallyStep } from './devCycleSteps';
import { startFixRoundIfPossible } from './devCycleFixRun';

export const PR_FEEDBACK_RUN_KIND = 'pr_feedback';

const TRIAGE_TIMEOUT_MS = 20 * 60 * 1000;

export interface PrFeedbackRunState extends DevCycleBaseState {
  round: number;
  /** Set once the round produced a code change (some thread was triaged as 'change'). */
  changeRequestId?: number;
}

const noChange = (state: PrFeedbackRunState) => (state.changeRequestId ? null : 'Skipped — no code change this round.');

/**
 * One round of review feedback on the cycle's PR: the threads waiting on
 * the author are triaged against the code (change vs answer, with the reply
 * drafted), the changes are implemented in a scratch worktree, and after one
 * human approval the change is committed, verified locally, pushed, every
 * thread gets its reply (blocker threads resolved), and the branch is built
 * on Jenkins. Rounds repeat as reviewers come back; the Bitbucket sync
 * starts them (watchDevCyclePr) and closes the cycle once the PR is merged.
 */
function steps(): StepEntry<PrFeedbackRunState>[] {
  return [
    {
      key: 'gather_feedback',
      label: 'Gather review feedback',
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const outcome = await watchDevCyclePr(cycle);
        if (!outcome) throw new Error('This cycle has no pull request yet.');
        if (outcome.kind !== 'open') throw new Error(`The pull request is ${outcome.kind} — nothing to address.`);
        upsertFeedbackThreads(cycle.id, outcome.threads, ctx.state.round);
        const pending = getPendingFeedback(cycle.id);
        ctx.log(pending.length ? `${pending.length} thread(s) waiting for a response: ${pending.map((p) => `#${p.id} ${p.author}`).join(', ')}.` : 'No review threads are waiting on you.');
        return pending.length ? `${pending.length} thread(s) to address.` : 'No new review feedback.';
      },
    },
    {
      key: 'triage',
      label: 'Triage (Claude)',
      timeoutMs: TRIAGE_TIMEOUT_MS,
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const pending = getPendingFeedback(cycle.id).filter((p) => p.status === 'open');
        if (!pending.length) return 'Nothing to triage.';
        const ref = prRefOf(cycle)!;
        const pr = await getPullRequest(ref.projectKey, ref.repoSlug, ref.id);
        const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
        ctx.log(`Reading the code behind ${pending.length} thread(s)…`);
        const result = await runClaudeCodeReview(buildTriagePrompt({ ticketKey: cycle.ticketKey, prTitle: pr.title, branch: cycle.branchName!, baseBranch: cycle.baseBranch, items: pending }), worktreePath, {
          jsonSchema: TRIAGE_JSON_SCHEMA,
          model: 'sonnet',
          onProgress: (m) => {
            ctx.log(m);
            ctx.detail(m);
          },
        });
        if (result.isError || !result.structuredOutput) throw new Error(result.resultText || 'The triage produced no structured result.');
        const triage = result.structuredOutput as TriageResult;
        let changes = 0;
        for (const item of pending) {
          const decision = triage.items.find((t) => t.id === item.id);
          if (!decision) continue;
          setFeedbackTriage(item.id, { action: decision.action, reply: decision.reply.trim(), changeInstruction: decision.action === 'change' ? decision.changeInstruction.trim() : null });
          if (decision.action === 'change') changes++;
          ctx.log(`#${item.id} ${item.author}: ${decision.action} — ${decision.reply.slice(0, 160)}`);
        }
        return `${changes} to change, ${pending.length - changes} to answer.`;
      },
    },
    {
      key: 'implement_feedback',
      label: 'Implement the changes (Claude)',
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const changes = getPendingFeedback(cycle.id).filter((p) => p.action === 'change');
        if (!changes.length) return 'Skipped — replies only, no code change.';
        const ref = prRefOf(cycle)!;
        const pr = await getPullRequest(ref.projectKey, ref.repoSlug, ref.id);
        const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
        ctx.log(`Implementing ${changes.length} change(s) from review feedback…`);
        const outcome = await dispatchClaudeChange(ctx, cycle, buildFeedbackChangesPrompt({ ticketKey: cycle.ticketKey, prTitle: pr.title, items: changes }), worktreePath, 'pr_feedback');
        ctx.state.changeRequestId = outcome.request.id;
        if (outcome.status !== 'ready') throw new Error(outcome.error ?? 'The change agent produced no diff.');
        ctx.log('Replies and changes ready for review — approve to commit, verify, push and reply.');
        return 'Changes ready for review.';
      },
    },
    applyStep<PrFeedbackRunState>({
      key: 'apply_feedback',
      label: 'Post replies & apply changes',
      request: (state) => (state.changeRequestId ? getCodeChangeRequest(state.changeRequestId) : undefined),
      commitMessage: (cycle) => `${cycle.ticketKey} address review feedback`,
      changeOptional: true,
    }),
    verifyLocallyStep<PrFeedbackRunState>({ skipWhen: noChange }),
    pushStep<PrFeedbackRunState>({ request: (state) => (state.changeRequestId ? getCodeChangeRequest(state.changeRequestId) : undefined), skipWhen: noChange }),
    {
      key: 'post_replies',
      label: 'Reply on the pull request',
      async run(ctx) {
        const cycle = cycleOf(ctx);
        const ref = prRefOf(cycle)!;
        const pending = getPendingFeedback(cycle.id).filter((p) => p.status === 'triaged' && p.reply);
        if (!pending.length) return 'Nothing to reply to.';
        let resolved = 0;
        for (const item of pending) {
          const posted = await addPullRequestComment(ref, { text: item.reply!, parentId: item.rootCommentId });
          let didResolve = false;
          if (item.action === 'change') {
            didResolve = await resolvePullRequestComment(ref, item.rootCommentId).catch((err: any) => {
              ctx.log(`Could not mark #${item.id} resolved: ${err.message}`);
              return false;
            });
            if (didResolve) resolved++;
          }
          markFeedbackAnswered(item.id, posted.id, didResolve);
          ctx.log(`Replied to ${item.author} (#${item.id})${didResolve ? ' and resolved the thread' : ''}.`);
        }
        return `Replied to ${pending.length} thread(s)${resolved ? `, ${resolved} resolved` : ''}.`;
      },
    },
    buildAndTestStep<PrFeedbackRunState>({ skipWhen: noChange }),
  ];
}

export const prFeedbackRunDefinition: RunDefinition<PrFeedbackRunState> = {
  kind: PR_FEEDBACK_RUN_KIND,
  steps,
  async finalize(run, outcome) {
    if (outcome !== 'failed') return;
    if (run.state.localFailure) await startFixRoundIfPossible(run.state.cycleId, { localFailure: run.state.localFailure }, 1);
    else if (run.state.failedBuild) await startFixRoundIfPossible(run.state.cycleId, { failedBuild: run.state.failedBuild }, 1);
  },
};

registerRunKind(prFeedbackRunDefinition);

/** The next round number for the cycle's feedback runs. */
function nextFeedbackRound(cycleId: number): number {
  const latest = getLatestDevCycleRun<any>(cycleId);
  return latest?.kind === PR_FEEDBACK_RUN_KIND ? (latest.state.round ?? 0) + 1 : 1;
}

/** Starts a feedback round for the cycle's PR; a run still in flight is cancelled first (a new round supersedes it). */
export async function startPrFeedbackRun(cycleId: number): Promise<Run<PrFeedbackRunState>> {
  const previous = getLatestDevCycleRun(cycleId);
  if (previous && !TERMINAL_RUN_STATUSES.includes(previous.status)) await cancelRun(previous.id);
  const round = nextFeedbackRound(cycleId);
  return startRun<PrFeedbackRunState>({ kind: PR_FEEDBACK_RUN_KIND, subjectKind: DEV_CYCLE_SUBJECT_KIND, subjectId: String(cycleId), state: { cycleId, round } });
}

/**
 * What the Bitbucket sync does for every active cycle with a PR: records
 * the threads waiting on the author and starts a round when there are any
 * and nothing is running for the cycle (a run in flight — e.g. a fix round
 * — gets to finish; the next sync starts the feedback round).
 */
export async function syncDevCyclePrFeedback(cycleId: number): Promise<'merged' | 'declined' | 'started' | 'idle' | 'busy'> {
  const cycle = getDevCycle(cycleId);
  if (!cycle || cycle.status !== 'active' || !cycle.prId) return 'idle';
  const outcome = await watchDevCyclePr(cycle);
  if (!outcome) return 'idle';
  if (outcome.kind !== 'open') return outcome.kind;
  if (!outcome.threads.length) return 'idle';
  const before = new Set(getPendingFeedback(cycle.id).map((p) => `${p.rootCommentId}:${p.text}`));
  upsertFeedbackThreads(cycle.id, outcome.threads, nextFeedbackRound(cycle.id));
  const pending = getPendingFeedback(cycle.id);
  if (!pending.length) return 'idle';
  const latest = getLatestDevCycleRun(cycle.id);
  if (latest && !TERMINAL_RUN_STATUSES.includes(latest.status)) return 'busy';
  // Only a round that has something new to say — otherwise an unanswered
  // thread the user chose to leave alone would restart a run every sync.
  const hasNew = pending.some((p) => !before.has(`${p.rootCommentId}:${p.text}`) && p.status === 'open');
  if (!hasNew && latest?.kind === PR_FEEDBACK_RUN_KIND) return 'idle';
  await startPrFeedbackRun(cycle.id);
  return 'started';
}

import * as fs from 'fs';
import { config } from '../../config';
import { getJiraIssueDetail } from '../../integrations/jiraMcp';
import { startClaudeCodeTask, getBackgroundTaskLogs, applyCodeChangeToRepo, pushRepoChanges, git, getTaskInfo } from '../../integrations/claudeCodeCli';
import { jobPathFor, getTestReport, getRecentBuilds } from '../../integrations/jenkinsClient';
import { assessUnstableBuild } from '../../dev/buildVerdict';
import { pollJenkinsBuilds } from '../../dev/jenkinsMonitor';
import { triggerJenkinsBuild, getQueueState, getBuildByNumber } from '../../integrations/jenkinsMcp';
import { createJenkinsBuildRequest, markJenkinsBuildRequestStarted } from '../../storage/jenkinsBuildRequestRepository';
import { LEGACY_NO_PUSH_URL } from '../../integrations/antigravityCli';
import { addWorktreeForExistingBranch } from '../../integrations/gitBranches';
import { pollCodeChangeRequest } from '../../integrations/codeChangePoller';
import { startDraft } from '../../drafts/draftService';
import { runLocalVerify } from '../../dev/localVerify';
import {
  CodeChangeOrigin,
  CodeChangeRequest,
  createCodeChangeRequest,
  getCodeChangeRequest,
  getLatestCodeChangeRequestForDevCycleOrigin,
  markCodeChangeApplied,
  markCodeChangePushed,
} from '../../storage/codeChangeRequestRepository';
import { DevCycle, getDevCycle, setDevCycleBranch, setDevCycleCurrentStep } from '../../storage/devCycleRepository';
import { getLatestRunForSubject, Run } from '../../storage/runRepository';
import { emitEvent } from '../engine';
import { StepContext, StepDefinition } from '../types';

/**
 * Steps and helpers shared by the dev-cycle run kinds (devCycleRun.ts, the
 * main pipeline; devCycleFixRun.ts, the build-fix loop): everything a cycle
 * produces lives on the dev_cycles row and its side tables, so any run kind
 * can pick the cycle up wherever it is.
 */

export const DEV_CYCLE_SUBJECT_KIND = 'dev_cycle';

const PUSH_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a change agent may work before it is stopped and its changes so far kept — a medium refactor (13 files, compiling and running tests in between) was still going at 20 minutes, seen live on ETICK-10173. */
const AGENT_WAIT_MS = 90 * 60 * 1000;
/** A cold compile of the changed modules plus their upstream reactor siblings, then the changed tests — the big reactor can take a while from a fresh worktree. */
const LOCAL_VERIFY_TIMEOUT_MS = 45 * 60 * 1000;
/** The integration job runs the whole suite (~3,200 tests, ~20 min seen live) and may wait for an executor first. */
const BUILD_TIMEOUT_MS = 90 * 60 * 1000;
const BUILD_POLL_MS = 20_000;

/** What the build step records before failing the run, so finalize can decide whether a fix round should follow. */
export interface FailedBuild {
  jobPath: string;
  jobFullName: string;
  buildNumber: number;
  result: string | null;
  newFailures: string[];
  reason: string;
}

/** What the local gate records before failing the run — the fix round's evidence when the failure never reached Jenkins. */
export interface LocalFailure {
  summary: string;
  failingTests: string[];
  output: string;
  modules: string[];
}

export interface DevCycleBaseState {
  cycleId: number;
  failedBuild?: FailedBuild;
  localFailure?: LocalFailure;
}

export function cycleOf(ctx: StepContext<DevCycleBaseState>): DevCycle {
  const cycle = getDevCycle(ctx.state.cycleId);
  if (!cycle) throw new Error(`Dev cycle ${ctx.state.cycleId} no longer exists.`);
  return cycle;
}

/** The cycle's most recent run of any kind (main pipeline or fix round) — the one the Jira-implement tab shows. */
export function getLatestDevCycleRun<S extends DevCycleBaseState = DevCycleBaseState>(cycleId: number): Run<S> | undefined {
  return getLatestRunForSubject(DEV_CYCLE_SUBJECT_KIND, String(cycleId)) as Run<S> | undefined;
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
  if (/accept edits on|shift\+tab to cycle|esc to interrupt|← for agents|\?\s*for shortcuts|·\s*\/effort$|\/btw to ask/i.test(line)) return true;
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

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** The cycle's primary worktree, re-created on the branch if it was removed (prOpenDraft removes worktrees once the PR is open; a later fix round needs one again). */
export async function ensureCycleWorktree(cycle: DevCycle, log: (m: string) => void): Promise<string> {
  if (!cycle.branchName) throw new Error('This dev cycle has no branch yet.');
  if (cycle.worktreePath && fs.existsSync(cycle.worktreePath)) return cycle.worktreePath;
  log(`Re-creating a worktree for ${cycle.branchName}…`);
  const worktreePath = await addWorktreeForExistingBranch(cycle.repoPath, cycle.branchName, 'fix');
  setDevCycleBranch(cycle.id, { branchName: cycle.branchName, worktreePath });
  return worktreePath;
}

export type ChangeOutcome = { request: CodeChangeRequest; status: 'ready' | 'failed'; diff: string | null; error: string | null };

/**
 * One Claude Code `--bg` agent run in a worktree, followed to its diff: a
 * code_change_requests row (the same record the apply step and the Diff tab
 * read), the agent's state polled, and `claude logs` tailed into the run log
 * — `--bg` has no streaming onProgress, so the tail is the only way to show
 * what the agent is doing rather than "Agent state: running" for minutes.
 */
/**
 * Prepended to every background agent prompt. `--worktree` drops the agent
 * in a scratch checkout of the branch under a throwaway name, and an agent
 * told "branch X" went looking for it with `git fetch`/`git branch` (seen
 * live) — pointless, and one prompt away from parking forever. It also
 * can't commit, so it must leave its edits in the working tree for Speako
 * to capture, and should prove them with the project's own tests.
 */
const AGENT_PREAMBLE = `You are working in a dedicated git worktree that already contains the branch's current code at the right commit. Do not fetch, check out, switch or create branches, and do not commit — leave your edits uncommitted in the working tree; they are captured from there. Project skills are not available in this session; run the build tool directly (e.g. \`mvn -q -pl <module> -Dtest=<TestClass> test\`) to run the relevant tests for the files you changed before you finish, and make them pass.

`;

/** Still known to the CLI and not killed: working, parked, or done with its diff still in its worktree (`claude agents` lists finished agents too; an unknown id is simply absent). */
async function isAgentAlive(cliSessionId: string): Promise<boolean> {
  try {
    const info = await getTaskInfo(cliSessionId);
    return !!info && !['stopped', 'failed', 'error'].includes(info.state);
  } catch {
    return false;
  }
}

export async function dispatchClaudeChange(ctx: StepContext<DevCycleBaseState>, cycle: DevCycle, prompt: string, worktreePath: string, origin: CodeChangeOrigin): Promise<ChangeOutcome> {
  // The agent gets its own detached scratch worktree at the branch's
  // commit and is launched *in* it — never in `worktreePath` (the cycle's
  // worktree, where the approved diff is later applied) and never via the
  // CLI's --worktree (see StartClaudeCodeTaskOptions.useWorktree). The diff
  // is captured from there and the scratch worktree removed afterwards.
  // An agent from before a Speako restart may still be working (they run
  // detached): pick its poll back up instead of starting a second one.
  const orphan = getLatestCodeChangeRequestForDevCycleOrigin(cycle.id, origin);
  let request: CodeChangeRequest;
  if (orphan?.status === 'running' && (await isAgentAlive(orphan.cliSessionId))) {
    ctx.log(`Re-attaching to the agent still running from before the restart (session ${orphan.cliSessionId})…`);
    request = orphan;
  } else {
    ctx.log('Preparing a scratch worktree for the agent…');
    const agentWorktree = await addWorktreeForExistingBranch(cycle.repoPath, cycle.branchName!, 'agent');
    const { cliSessionId } = await startClaudeCodeTask(AGENT_PREAMBLE + prompt, agentWorktree, 'sonnet', { useWorktree: false });
    request = createCodeChangeRequest({ taskId: cycle.taskId ?? undefined, devCycleId: cycle.id, origin, repoName: cycle.repoName, repoPath: worktreePath, cliSessionId });
  }
  const { cliSessionId } = request;
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
  await pollCodeChangeRequest(request.id, emitEvent, { maxWaitMs: AGENT_WAIT_MS });
  tailingStopped = true;
  await tail;
  const finished = getCodeChangeRequest(request.id)!;
  if (finished.status === 'ready') return { request: finished, status: 'ready', diff: finished.diff ?? '', error: null };
  return { request: finished, status: 'failed', diff: null, error: finished.error ?? 'Claude Code agent failed.' };
}

/**
 * The human-gated "commit this diff" step, shared by the merged
 * implementation and by a fix round. Resumable: the change request's own
 * status says whether a previous attempt already committed, so a retry
 * never re-applies an already-committed diff. The push is a separate step
 * (pushStep) so the local gate can run in between.
 */
export function applyStep<S extends DevCycleBaseState>(options: {
  key: string;
  label: string;
  /** The change to land — looked up at run time so a retry sees the same row. */
  request: (state: S) => CodeChangeRequest | undefined;
  commitMessage: (cycle: DevCycle, ticketSummary: string | null, state: S) => string;
  /** A round may legitimately have no code change (review feedback answered with replies only) — then this step is a no-op rather than a failure. */
  changeOptional?: boolean;
}): StepDefinition<S> {
  return {
    key: options.key,
    label: options.label,
    approval: true,
    timeoutMs: PUSH_TIMEOUT_MS,
    async run(ctx) {
      const cycle = cycleOf(ctx);
      const request = options.request(ctx.state);
      if (!request && options.changeOptional) {
        ctx.log('No code change this round.');
        return 'No code change this round.';
      }
      if (!request || !['ready', 'applied', 'pushed'].includes(request.status) || !cycle.branchName) throw new Error('No change ready to apply.');
      const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
      if (request.status === 'ready') {
        const ticket = await getJiraIssueDetail(cycle.ticketKey).catch(() => null);
        await applyCodeChangeToRepo(request.diff ?? '', worktreePath, options.commitMessage(cycle, ticket?.summary ?? null, ctx.state));
        markCodeChangeApplied(request.id);
        emitEvent({ type: 'code-change-applied', devCycleId: cycle.id, requestId: request.id });
        ctx.log(`Committed to ${cycle.branchName} (not pushed yet).`);
        return 'Committed.';
      }
      ctx.log('The change was already committed by a previous attempt.');
      return 'Already committed.';
    },
  };
}

/**
 * Speako's own gate before anything leaves the machine: compile the changed
 * modules and run the changed tests locally (src/dev/localVerify.ts). A
 * failure records the evidence in state.localFailure and fails the run, so
 * the fix loop can take over without a Jenkins round.
 */
export function verifyLocallyStep<S extends DevCycleBaseState>(options: { skipWhen?: (state: S) => string | null } = {}): StepDefinition<S> {
  return {
    key: 'verify_locally',
    label: 'Build & test locally',
    timeoutMs: LOCAL_VERIFY_TIMEOUT_MS,
    async run(ctx) {
      const skip = options.skipWhen?.(ctx.state);
      if (skip) return skip;
      const cycle = cycleOf(ctx);
      const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
      const result = await runLocalVerify(worktreePath, cycle.baseBranch, ctx.log, ctx.signal);
      if (!result.ok) {
        // A gate that could not run is not a code failure: no fix round
        // (seen live: a fix agent correctly found nothing to fix and the
        // round failed), the step fails for the developer to retry.
        if (!result.toolingFailure) ctx.state.localFailure = { summary: result.summary, failingTests: result.failingTests, output: result.output, modules: result.modules };
        throw new Error(result.summary);
      }
      ctx.log(result.summary);
      return result.summary;
    },
  };
}

/** Pushes the branch once the local gate passed. Resumable like applyStep: a change already marked pushed is not pushed again. */
export function pushStep<S extends DevCycleBaseState>(options: { request: (state: S) => CodeChangeRequest | undefined; skipWhen?: (state: S) => string | null }): StepDefinition<S> {
  return {
    key: 'push',
    label: 'Push',
    timeoutMs: PUSH_TIMEOUT_MS,
    async run(ctx) {
      const skip = options.skipWhen?.(ctx.state);
      if (skip) return skip;
      const cycle = cycleOf(ctx);
      const request = options.request(ctx.state);
      if (!request || !cycle.branchName) throw new Error('No committed change to push.');
      const worktreePath = await ensureCycleWorktree(cycle, ctx.log);
      if (request.status !== 'pushed') {
        // An earlier Speako version blocked Antigravity's pushes by writing
        // a bogus push URL into the shared repo config (see antigravityCli.ts);
        // a repo that still carries it can't push from any worktree.
        const pushUrl = await git(['config', '--get', 'remote.origin.pushurl'], cycle.repoPath).catch(() => '');
        if (pushUrl.trim() === LEGACY_NO_PUSH_URL) {
          await git(['config', '--unset', 'remote.origin.pushurl'], cycle.repoPath);
          ctx.log('Removed a leftover push block from an earlier Speako version from the repo config.');
        }
        await pushRepoChanges(worktreePath);
        markCodeChangePushed(request.id);
        emitEvent({ type: 'code-change-pushed', devCycleId: cycle.id, requestId: request.id });
      } else {
        ctx.log('Already pushed by a previous attempt.');
      }
      // 'done' is what unlocks the PR/Docs tabs — the PR draft itself only
      // auto-starts once the build is green, but "Draft PR now" stays
      // available as the manual escape hatch.
      setDevCycleCurrentStep(cycle.id, 'done');
      ctx.log(`Pushed to ${cycle.branchName}.`);
      return `Pushed to ${cycle.branchName}.`;
    },
  };
}

/**
 * Builds and tests the branch on the shared Jenkins job and waits for the
 * verdict. UNSTABLE is judged against the job's own history (buildVerdict.ts)
 * — the shared job's baseline is itself unstable. A red build records what
 * failed in `state.failedBuild` before throwing, so the run's finalize can
 * start a fix round. Skipped (not failed) when no job is configured.
 */
export function buildAndTestStep<S extends DevCycleBaseState>(options: { skipWhen?: (state: S) => string | null } = {}): StepDefinition<S> {
  return {
    key: 'build_and_test',
    label: 'Build & test on Jenkins',
    timeoutMs: BUILD_TIMEOUT_MS,
    async run(ctx) {
      const skip = options.skipWhen?.(ctx.state);
      if (skip) return skip;
      const cycle = cycleOf(ctx);
      if (!config.jenkinsTestJob) return 'Skipped — no build & test job configured (Settings > Jenkins).';
      if (!cycle.branchName) throw new Error('This cycle has no branch to build.');
      const jobFullName = config.jenkinsTestJob;
      const jobPath = jobPathFor(jobFullName);
      const queueId = await triggerJenkinsBuild(jobFullName, { [config.jenkinsTestBranchParam]: cycle.branchName });
      // Recorded so jenkinsMonitor.ts follows the same build into the Tests
      // tab (build rows + failure classification); this step only waits for
      // the verdict.
      const buildRequest = createJenkinsBuildRequest({ devCycleId: cycle.id, jobPath, jobFullName, branchName: cycle.branchName, queueId });
      ctx.log(`Queued ${jobFullName} for ${cycle.branchName} (queue item ${queueId}).`);
      let buildNumber: number | null = null;
      const fail = (result: string | null, newFailures: string[], reason: string, url: string): never => {
        ctx.state.failedBuild = { jobPath, jobFullName, buildNumber: buildNumber!, result, newFailures, reason };
        throw new Error(`Build #${buildNumber} ${reason} — ${url}`);
      };
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
            // failure classification) instead of waiting for the monitor's next tick.
            await pollJenkinsBuilds(emitEvent).catch((err: any) => ctx.log(`Could not record the build in the Tests tab yet: ${err.message}`));
            if (build.result === 'SUCCESS') {
              ctx.log(`Build #${buildNumber} passed.`);
              return `Build #${buildNumber} passed.`;
            }
            if (build.result === 'UNSTABLE') {
              const recent = (await getRecentBuilds(jobPath, 7)).filter((b) => b.number !== buildNumber && !b.building).slice(0, 5);
              const [report, ...recentReports] = await Promise.all([getTestReport(jobPath, buildNumber), ...recent.map((b) => getTestReport(jobPath, b.number))]);
              const verdict = assessUnstableBuild(report, recentReports.filter((r): r is NonNullable<typeof r> => !!r));
              if (verdict.preexistingFailures.length) ctx.log(`Pre-existing failures (also failing before this branch): ${verdict.preexistingFailures.join(', ')}`);
              if (verdict.pass) {
                ctx.log(`Build #${buildNumber} unstable — ${verdict.reason}; treating as passed.`);
                return `Build #${buildNumber} unstable — ${verdict.reason}.`;
              }
              return fail('UNSTABLE', verdict.newFailures, `UNSTABLE — ${verdict.reason}`, build.url);
            }
            return fail(build.result, [], build.result ?? 'ended without a result', build.url);
          }
          ctx.detail(`Build #${buildNumber} running…`);
        }
        await sleep(BUILD_POLL_MS, ctx.signal);
      }
      throw new Error('Cancelled while waiting for the build.');
    },
  };
}

/** Once a build is green: the PR is drafted on a tested branch (no-op if the cycle already has a PR). */
export async function startPrDraftAfterGreenBuild(cycleId: number): Promise<void> {
  const cycle = getDevCycle(cycleId);
  if (!cycle || cycle.prId) return;
  await startDraft({ kind: 'pr_open', subjectId: cycleId }).catch((err: any) => {
    console.error(`[dev-cycle] failed to auto-start PR open for cycle ${cycleId}:`, err.message);
  });
}

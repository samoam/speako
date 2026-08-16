import { config } from '../../config';
import { DevCycle, getDevCycle, setDevCyclePr } from '../../storage/devCycleRepository';
import { getLatestDraftForSubject } from '../../storage/draftRepository';
import { getJiraIssueDetail } from '../../integrations/jiraMcp';
import { getBranchDiffStat, branchExistsOnRemote } from '../../integrations/gitBranches';
import { runClaudeCodeReview } from '../../integrations/claudeCodeCli';
import { createPullRequest } from '../../integrations/bitbucketServer';
import { runDeterministicChecks, buildPrePrPrompt, PRE_PR_JSON_SCHEMA, PrePrAgentResult, DeterministicCheckResult } from '../../dev/prePrChecks';
import { buildPrTitle, buildPrDescription } from '../../dev/prDescription';
import { StructuredDevPlan } from '../../dev/devPlan';
import { DraftHandler } from '../types';
import { emitDraftLog, startDraft } from '../draftService';

export interface PrOpenContent {
  title: string;
  description: string;
  projectKey: string;
  repoSlug: string;
  fromBranch: string;
  toBranch: string;
  reviewers: string[];
  checks: { deterministic: DeterministicCheckResult[]; agent: PrePrAgentResult | null };
  overridden: boolean;
}

/**
 * Opens the PR — the last step of the plan-before-code cycle (blueprint
 * §5.1 steps 5-7). Runs the pre-PR self-review checklist (src/dev/prePrChecks.ts)
 * AS PART OF drafting, rather than a separate gate/table: the checklist
 * result is just part of what the human reviews before approving, same
 * "generic gate is the single source of truth" pattern devPlanDraft.ts
 * already established. supportsRefine is false — re-running the whole
 * checklist per chat turn would be expensive; title/description/reviewers
 * are edited directly instead.
 */
export const prOpenDraft: DraftHandler<DevCycle> = {
  kind: 'pr_open',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'open', label: 'Open PR' }],
  redoStrategy: 'fresh',
  supportsRefine: false,
  loadSubject: (subjectId) => getDevCycle(Number(subjectId)),
  async generate(input) {
    const cycle = input.subject;
    if (!cycle.branchName || !cycle.worktreePath) {
      throw new Error('This dev cycle has no branch yet — create the branch and get an implementation approved first.');
    }

    const ticket = await getJiraIssueDetail(cycle.ticketKey);
    if (!ticket) throw new Error(`Jira issue ${cycle.ticketKey} was not found.`);

    const planDraft = getLatestDraftForSubject('dev_cycle', cycle.id, 'dev_plan');
    const plan = (planDraft?.content ?? null) as StructuredDevPlan | null;

    const log = (message: string) => emitDraftLog(input.draftId, message);
    log('Running deterministic checks…');
    const deterministic = await runDeterministicChecks(cycle.worktreePath, cycle.baseBranch, cycle.jenkinsJobPath);

    log('Running self-review…');
    const prompt = buildPrePrPrompt({ ticketSummary: ticket.summary, ticketDescription: ticket.description, deterministic });
    const result = await runClaudeCodeReview(prompt, cycle.worktreePath, { jsonSchema: PRE_PR_JSON_SCHEMA, onProgress: log });
    const agent = !result.isError && result.structuredOutput ? (result.structuredOutput as PrePrAgentResult) : null;

    const diffStat = await getBranchDiffStat(cycle.worktreePath, cycle.baseBranch);
    const jiraBrowseUrl = `${config.jiraUrl.replace(/\/$/, '')}/browse/${cycle.ticketKey}`;
    const description = buildPrDescription({ ticketKey: cycle.ticketKey, jiraBrowseUrl, plan, deterministic, agent, overridden: false, diffStat });
    const title = buildPrTitle(cycle.ticketKey, ticket.summary);

    // Blueprint §5.1 step 6 / §6 item 2: auto-draft a Confluence update
    // alongside PR-open readiness when the self-review agent judges the
    // change documentation-worthy. Fire-and-forget — a failure here must
    // never block or fail the PR-open draft itself. Dedup via
    // getLatestDraftForSubject: redoing pr_open (a fresh generate() call)
    // never creates a second Confluence draft once one exists for this cycle.
    if (agent?.confluenceRelevant && !getLatestDraftForSubject('dev_cycle', cycle.id, 'confluence_dev_cycle_update')) {
      startDraft({ kind: 'confluence_dev_cycle_update', subjectId: String(cycle.id) }).catch((err: any) =>
        emitDraftLog(input.draftId, `Confluence draft failed to auto-generate: ${err.message}`)
      );
    }

    // Auto-picks the Bitbucket project/repo only when exactly one is
    // configured (same convention as the existing implement/review routes'
    // repoName auto-pick) — otherwise left blank for the user to fill in.
    const singleRepo = config.bitbucketServerRepos.length === 1 ? config.bitbucketServerRepos[0] : null;

    const content: PrOpenContent = {
      title,
      description,
      projectKey: singleRepo?.project ?? '',
      repoSlug: singleRepo?.repo ?? '',
      fromBranch: cycle.branchName,
      toBranch: cycle.baseBranch,
      reviewers: [],
      checks: { deterministic, agent },
      overridden: false,
    };
    return { mode: 'draft', content };
  },
  async execute(_gateKey, ctx) {
    const cycle = ctx.subject;
    const content = ctx.content as PrOpenContent;
    if (cycle.prId) throw new Error('This dev cycle already has an open PR.');
    if (!content.projectKey || !content.repoSlug) throw new Error('Bitbucket project key and repo slug are required.');
    if (content.checks.agent?.verdict === 'blocked' && !content.overridden) {
      throw new Error('The self-review found a blocking issue — check "Open anyway" to proceed, or address the gap first.');
    }

    const pushed = await branchExistsOnRemote(cycle.repoPath, cycle.branchName!);
    if (!pushed) {
      throw new Error(`Branch "${cycle.branchName}" hasn't been pushed to origin yet — approve and push your implementation first.`);
    }

    const pr = await createPullRequest({
      projectKey: content.projectKey,
      repoSlug: content.repoSlug,
      title: content.title,
      description: content.description,
      fromBranch: cycle.branchName!,
      toBranch: content.toBranch,
      reviewerUsernames: content.reviewers,
    });
    setDevCyclePr(cycle.id, { projectKey: content.projectKey, repoSlug: content.repoSlug, prId: pr.id, prUrl: pr.link });
    return { projectKey: content.projectKey, repoSlug: content.repoSlug, prId: pr.id, prUrl: pr.link };
  },
  legacyBroadcast(draft) {
    return [{ type: 'dev-cycle-updated', devCycleId: Number(draft.subjectId) }];
  },
};

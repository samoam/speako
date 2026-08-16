import { DevCycle, getDevCycle, setDevCycleBranch } from '../../storage/devCycleRepository';
import { getJiraIssueDetail } from '../../integrations/jiraMcp';
import { buildBranchName } from '../../dev/branchNaming';
import { createTicketBranchWorktree } from '../../integrations/gitBranches';
import { lifecycleTransitionSubjectId } from './jiraTransitionDraft';
import { DraftHandler } from '../types';
import { startDraft } from '../draftService';

export interface GitBranchCreateContent {
  branchName: string;
  baseBranch: string;
}

/**
 * Branch creation for a dev cycle — the first step of the Jira -> branch ->
 * PR cycle (blueprint §5.1 step 3/§5.3). Chat refinement doesn't apply to a
 * branch name (supportsRefine: false); the user edits the field directly if
 * the suggested name isn't right. Approving this draft both creates the
 * branch/worktree AND immediately kicks off the plan-before-code step
 * (dev_plan draft) — "branch created + implementation work starts" is one
 * approval per the blueprint, even though the actual code-writing agent
 * still waits for the plan's own separate approval.
 */
export const gitBranchCreateDraft: DraftHandler<DevCycle> = {
  kind: 'git_branch_create',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'create', label: 'Create branch' }],
  redoStrategy: 'fresh',
  supportsRefine: false,
  loadSubject: (subjectId) => getDevCycle(Number(subjectId)),
  async generate(input) {
    const cycle = input.subject;
    const ticket = await getJiraIssueDetail(cycle.ticketKey).catch(() => null);
    const summary = ticket?.summary || cycle.ticketKey;
    const branchName = buildBranchName({ type: cycle.branchType, ticketKey: cycle.ticketKey, summary });
    return { mode: 'draft', content: { branchName, baseBranch: cycle.baseBranch } };
  },
  async execute(_gateKey, ctx) {
    const cycle = ctx.subject;
    const content = ctx.content as GitBranchCreateContent;
    if (!content.branchName?.trim()) throw new Error('A branch name is required.');
    const worktreePath = await createTicketBranchWorktree(cycle.repoPath, content.branchName.trim(), content.baseBranch || cycle.baseBranch);
    setDevCycleBranch(cycle.id, { branchName: content.branchName.trim(), worktreePath });

    // "Branch created + implementation work starts" is one approval
    // (blueprint §5.1 step 3/4) — but the actual Jira Dev Ready -> In
    // Progress write is still its own separately-gated draft, same as every
    // other Jira write in this app; it's only auto-STARTED here, not
    // auto-applied. Non-fatal if Jira isn't configured or the ticket isn't
    // actually in Dev Ready — a branch getting created is never undone by a
    // Jira hiccup.
    startDraft({ kind: 'jira_transition', subjectId: lifecycleTransitionSubjectId(cycle.id, 'In Progress') }).catch((err: any) => {
      console.error(`[dev-cycle] failed to auto-start the Dev Ready -> In Progress transition for cycle ${cycle.id}:`, err.message);
    });
    startDraft({ kind: 'dev_plan', subjectId: cycle.id }).catch((err: any) => {
      console.error(`[dev-cycle] failed to auto-start the plan for cycle ${cycle.id}:`, err.message);
    });

    return { branchName: content.branchName.trim(), worktreePath };
  },
  legacyBroadcast(draft) {
    return [{ type: 'dev-cycle-updated', devCycleId: Number(draft.subjectId) }];
  },
};

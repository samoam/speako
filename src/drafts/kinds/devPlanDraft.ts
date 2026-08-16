import { DevCycle, getDevCycle } from '../../storage/devCycleRepository';
import { getTaskById } from '../../storage/taskRepository';
import { createCodeChangeRequest } from '../../storage/codeChangeRequestRepository';
import { startClaudeCodeTask, runClaudeCodeReview } from '../../integrations/claudeCodeCli';
import { pollCodeChangeRequest } from '../../integrations/codeChangePoller';
import { gatherPlanContext, buildPlanPrompt, DEV_PLAN_JSON_SCHEMA, StructuredDevPlan } from '../../dev/devPlan';
import { DraftHandler } from '../types';
import { emitDraftLog, getDraftBroadcaster } from '../draftService';

/**
 * Plan-before-code — grounds a short technical plan in the real ticket +
 * codebase (src/dev/devPlan.ts) and requires an explicit go/no-go before any
 * code gets written (blueprint §5.1 step 2). Runs via the existing
 * runClaudeCodeReview (already read-only/schema-constrained), so this kind
 * needs no new CLI plumbing — only approving the plan dispatches a real
 * writing agent, via the same code_change_requests/commit/push gates every
 * other "Implement with Claude Code" flow already uses.
 */
export const devPlanDraft: DraftHandler<DevCycle> = {
  kind: 'dev_plan',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'approve', label: 'Approve plan & implement' }],
  redoStrategy: 'fresh',
  loadSubject: (subjectId) => getDevCycle(Number(subjectId)),
  async generate(input) {
    const cycle = input.subject;
    if (!cycle.branchName || !cycle.worktreePath) {
      throw new Error('This dev cycle has no branch yet — create the branch first.');
    }

    const log = (message: string) => emitDraftLog(input.draftId, message);
    log('Gathering ticket and codebase context…');
    const ctx = await gatherPlanContext(cycle.ticketKey, cycle.repoName);

    const previousPlan = (input.redo?.priorContent ?? (input.instruction ? input.priorContent : undefined)) as StructuredDevPlan | undefined;
    const feedback = input.redo?.instruction ?? input.instruction;
    const returnReason = input.redo && !input.instruction ? input.redo.instruction : undefined;

    const prompt = buildPlanPrompt(ctx, { previousPlan, feedback, returnReason });
    log('Planning…');
    const result = await runClaudeCodeReview(prompt, cycle.worktreePath, {
      jsonSchema: DEV_PLAN_JSON_SCHEMA,
      onProgress: log,
    });
    if (result.isError || !result.structuredOutput) {
      throw new Error(result.resultText || 'The plan agent did not return a usable plan.');
    }
    return { mode: 'draft', content: result.structuredOutput as StructuredDevPlan };
  },
  async execute(_gateKey, ctx) {
    const cycle = ctx.subject;
    const plan = ctx.content as StructuredDevPlan;
    if (!cycle.worktreePath) throw new Error('This dev cycle has no branch worktree — create the branch first.');

    const prompt = `Implement Jira ticket ${cycle.ticketKey} following this approved plan exactly. If you must deviate from it, make the minimum necessary change and clearly state the deviation in your final message.

Plan:
${JSON.stringify(plan, null, 2)}`;

    const { cliSessionId } = await startClaudeCodeTask(prompt, cycle.worktreePath);
    const task = cycle.taskId ? getTaskById(cycle.taskId) : undefined;
    const request = createCodeChangeRequest({
      taskId: task?.id,
      devCycleId: cycle.id,
      origin: 'dev_plan',
      repoName: cycle.repoName,
      repoPath: cycle.worktreePath,
      cliSessionId,
    });

    pollCodeChangeRequest(request.id, getDraftBroadcaster()).catch((err: any) => {
      console.error(`[dev-cycle] polling failed for code change request ${request.id}:`, err.message);
    });

    return { codeChangeRequestId: request.id, cliSessionId };
  },
  legacyBroadcast(draft) {
    return [{ type: 'dev-cycle-updated', devCycleId: Number(draft.subjectId) }];
  },
};

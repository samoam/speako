import { DevCycle, getDevCycle, setDevCycleState, bumpDevCycleRound } from '../../storage/devCycleRepository';
import { LifecycleState, assertProposable } from '../../dev/lifecycle';
import { getCurrentLifecycleState, resolveTransition, transitionIssue } from '../../integrations/jiraTransitions';
import { DraftHandler } from '../types';

export interface LifecycleTransitionContent {
  toState: LifecycleState;
  comment: string;
}

export interface LifecycleTransitionSubject {
  cycle: DevCycle;
  targetState: LifecycleState;
}

/**
 * subjectId is the composite "<devCycleId>:<targetState>" rather than a
 * plain numeric id — a jira_transition draft is meaningless without knowing
 * WHICH transition is being proposed, and the generic DraftGenerateInput has
 * no dedicated field for that (unlike subject/instruction/redo, which every
 * kind needs). See lifecycleTransitionSubjectId() below for the encoder.
 */
function parseSubjectId(subjectId: string): { cycleId: number; targetState: LifecycleState } | null {
  const separatorIndex = subjectId.indexOf(':');
  if (separatorIndex === -1) return null;
  const cycleId = Number(subjectId.slice(0, separatorIndex));
  const targetState = subjectId.slice(separatorIndex + 1) as LifecycleState;
  if (!Number.isFinite(cycleId) || !targetState) return null;
  return { cycleId, targetState };
}

export function lifecycleTransitionSubjectId(devCycleId: number, targetState: LifecycleState): string {
  return `${devCycleId}:${targetState}`;
}

/**
 * A single Jira status transition, gated like every other write in this app
 * — the fixed lifecycle graph (src/dev/lifecycle.ts) is enforced twice: once
 * when the draft is generated, and again at approve time (staleness guard —
 * the ticket may have moved since the draft was created). Only the comment
 * is freely editable via chat; the target state itself is server-computed
 * from the fixed graph and never something the user or the model can widen.
 */
export const jiraTransitionDraft: DraftHandler<LifecycleTransitionSubject> = {
  kind: 'jira_transition',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'transition', label: 'Apply transition' }],
  redoStrategy: 'follow_up',
  loadSubject(subjectId) {
    const parsed = parseSubjectId(subjectId);
    if (!parsed) return undefined;
    const cycle = getDevCycle(parsed.cycleId);
    if (!cycle) return undefined;
    return { cycle, targetState: parsed.targetState };
  },
  async generate(input) {
    const { cycle, targetState } = input.subject;

    if (input.redo) {
      return { mode: 'draft', content: { toState: targetState, comment: input.redo.instruction || 'Following up.' } };
    }
    if (input.instruction) {
      // Only the comment is refinable — the target state is never something chat can change.
      const priorContent = input.priorContent as LifecycleTransitionContent;
      return { mode: 'draft', content: { ...priorContent, comment: input.instruction } };
    }

    const from = await getCurrentLifecycleState(cycle.ticketKey);
    if (!from) {
      throw new Error(`${cycle.ticketKey}'s current Jira status doesn't map to a known lifecycle state — cannot propose a transition.`);
    }
    assertProposable(from, targetState);
    return { mode: 'draft', content: { toState: targetState, comment: `Transitioning ${cycle.ticketKey} to ${targetState}.` } };
  },
  async execute(_gateKey, ctx) {
    const { cycle } = ctx.subject;
    const content = ctx.content as LifecycleTransitionContent;

    // Re-read live status and re-validate right before writing — the ticket
    // may have moved (or been transitioned by someone else) since this
    // draft was created.
    const from = await getCurrentLifecycleState(cycle.ticketKey);
    if (!from) {
      throw new Error(`${cycle.ticketKey}'s current Jira status doesn't map to a known lifecycle state.`);
    }
    assertProposable(from, content.toState);

    const transition = await resolveTransition(cycle.ticketKey, content.toState);
    await transitionIssue(cycle.ticketKey, transition.id, content.comment || undefined);
    setDevCycleState(cycle.id, content.toState);
    // Entering Return (QA rejected) is the trigger for a new plan/implement
    // round on re-entry — bumped here, at the moment Speako observes/applies
    // the Return-adjacent transition, not deferred to some later step.
    if (content.toState === 'In Progress' && from === 'Return') {
      bumpDevCycleRound(cycle.id);
    }
    return { toState: content.toState, transitionId: transition.id };
  },
  legacyBroadcast(draft) {
    const parsed = parseSubjectId(draft.subjectId);
    return parsed ? [{ type: 'dev-cycle-updated', devCycleId: parsed.cycleId }] : undefined;
  },
};

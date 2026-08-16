import { StructuredDevPlan } from './devPlan';
import { DeterministicCheckResult, PrePrAgentResult } from './prePrChecks';
import { BranchDiffStat } from '../integrations/gitBranches';

export function buildPrTitle(ticketKey: string, summary: string): string {
  return `${ticketKey}: ${summary}`.slice(0, 255);
}

export interface PrDescriptionInput {
  ticketKey: string;
  jiraBrowseUrl: string;
  plan: StructuredDevPlan | null;
  deterministic: DeterministicCheckResult[];
  agent: PrePrAgentResult | null;
  overridden: boolean;
  diffStat: BranchDiffStat;
}

/** Every section is omitted cleanly when its input is null/empty, so a cycle that skipped a step (e.g. no plan on record) still produces a sane description rather than a broken template. */
export function buildPrDescription(input: PrDescriptionInput): string {
  const sections: string[] = [];

  sections.push(`**Ticket:** [${input.ticketKey}](${input.jiraBrowseUrl})`);

  if (input.plan) {
    sections.push(`**What & why**\n${input.plan.understanding}`);
    sections.push(`**Approach**\n${input.plan.approach}`);
  }

  sections.push(`**Files changed:** ${input.diffStat.files.length} file(s), +${input.diffStat.insertions}/-${input.diffStat.deletions}`);

  if (input.plan?.tests?.length) {
    sections.push(`**Testing**\n${input.plan.tests.map((t) => `- ${t}`).join('\n')}`);
  }

  const checkLines = input.deterministic.map((c) => {
    const box = c.status === 'pass' ? 'x' : ' ';
    const note = c.status !== 'pass' && c.status !== 'skipped' ? ` — ${c.detail}` : '';
    return `- [${box}] ${c.title}${note}`;
  });
  if (input.agent) {
    checkLines.push(`- Self-review verdict: **${input.agent.verdict}** — ${input.agent.summary}`);
    if (input.agent.scopeCreep.length) {
      checkLines.push(`- Scope creep flagged: ${input.agent.scopeCreep.map((s) => s.file).join(', ')}`);
    }
  }
  let selfReviewSection = `**Self-review**\n${checkLines.join('\n')}`;
  if (input.overridden) selfReviewSection += '\n\n_Gaps acknowledged by the author before opening this PR._';
  sections.push(selfReviewSection);

  return sections.join('\n\n');
}

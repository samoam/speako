import { getSentimentScoresForSession } from '../../storage/sentimentRepository';
import { WorkflowContext, WorkflowResult, gatherSources, gatherToolSources, previousSessionNotes, trySource } from './types';

const FRICTION_SCORE_THRESHOLD = -0.3;

/**
 * §6.2: previous retro's action items (were they followed through?), this
 * sprint's Jira outcome, a retro template/prior-notes page from Confluence,
 * and — reusing data Speako already collects live, no new integration
 * needed — notably negative sentiment moments from the linked prior
 * meeting as candidate "what didn't go well" prompts. Framed as prompts for
 * discussion, not conclusions (see TYPE_EMPHASIS in synthesizeBrief.ts) —
 * retros should surface the team's own perspective, not a tool's verdict.
 */
export async function gather(ctx: WorkflowContext): Promise<WorkflowResult> {
  return gatherSources([
    trySource('previous_retro_action_items', () => previousSessionNotes(ctx.previousSession)),
    ...gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_sprint_outcome', query: 'completed this sprint OR carried over', limit: 8 },
      { tool: 'confluence', name: 'confluence_retro_template', query: 'retrospective template retro notes', limit: 2 },
    ]),
    trySource('sentiment_friction_signals', async () => {
      if (!ctx.previousSession) return '';
      const scores = getSentimentScoresForSession(ctx.previousSession.id);
      const negative = scores.filter((s) => s.score <= FRICTION_SCORE_THRESHOLD);
      if (negative.length === 0) return '';
      return `${negative.length} moment(s) of notably negative tone were flagged during the last tracked meeting (speaker, approx score): ${negative
        .slice(0, 5)
        .map((s) => `${s.speaker} (${s.score.toFixed(2)})`)
        .join(', ')} — worth asking about, not a diagnosis of what happened.`;
    }),
  ]);
}

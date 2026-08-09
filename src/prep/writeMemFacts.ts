import { addMemory, isMem0Configured } from '../integrations/mem0Client';
import { Summary, ActionItem } from '../storage/summaryRepository';

/**
 * Writes a handful of distilled durable facts to mem0 after a summary is
 * generated (§5.5 "compounding memory layer") — never the raw transcript,
 * and capped low (at most 3 memories) so mem0 doesn't fill up with
 * transcript-derived noise. Fire-and-forget, never throws to its caller.
 */
export async function writeSummaryFactsToMem0(sessionName: string | null, summary: Summary, actionItems: ActionItem[]): Promise<void> {
  if (!isMem0Configured()) return;

  const label = sessionName ? `In "${sessionName}"` : 'In a meeting';
  const facts: string[] = [];

  if (summary.keyDecisions.trim()) {
    facts.push(`${label}, this decision was made: ${summary.keyDecisions}`);
  }
  for (const item of actionItems.filter((a) => a.confidence === 'explicit').slice(0, 2)) {
    facts.push(`${label}, ${item.owner || 'someone'} committed to: ${item.description}`);
  }

  for (const fact of facts.slice(0, 3)) {
    try {
      await addMemory(fact);
    } catch (err: any) {
      console.error('[prep] failed to write fact to mem0:', err.message);
    }
  }
}

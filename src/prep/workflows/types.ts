import { getSummary, getActionItems } from '../../storage/summaryRepository';
import { isToolActive, ToolKey } from '../../tools/activeTools';
import { searchByTool } from '../toolCatalog';

export interface WorkflowContext {
  sessionId: string;
  sessionName?: string;
  /** Free text the user typed before clicking "Prepare session" — see PrepService.ts/synthesizeBrief.ts. */
  userNotes?: string;
  meetingType: string;
  previousSession?: { id: string; name: string | null };
  /** Which tools this session has active — null means "all globally-configured tools." See src/tools/activeTools.ts. */
  activeTools: string[] | null;
}

/**
 * Builds the search topic for keyword-driven workflows (design/dev, generic)
 * from BOTH the session name and user notes, not session name alone — a
 * ticket key or keyword the user only mentioned in notes (e.g. "Design
 * about jira:ETICK-10021" with a blank session name) must still reach the
 * actual Jira/Confluence/Bitbucket search calls, not just the final
 * synthesis prompt. jiraMcp.ts's searchJira already extracts and directly
 * looks up any ticket key found in its query text, so combining notes in
 * here is what makes that direct-lookup path actually fire.
 */
export function searchTopic(ctx: Pick<WorkflowContext, 'sessionName' | 'userNotes'>, fallback: string): string {
  const parts = [ctx.sessionName, ctx.userNotes].map((s) => s?.trim()).filter(Boolean);
  return parts.length ? parts.join(' — ') : fallback;
}

export interface WorkflowSource {
  name: string;
  content: string;
}

export interface WorkflowResult {
  sources: WorkflowSource[];
}

/**
 * Wraps one source fetch so a single failing integration (bad Jira key, mem0
 * unreachable, etc) can't take down the whole prep run — matches the
 * resource-level failure tolerance used elsewhere in this feature. Returns
 * null (silently dropped) on empty content or any thrown error, including
 * the "not configured" errors every integration client throws.
 */
export async function trySource(name: string, fn: () => Promise<string>): Promise<WorkflowSource | null> {
  try {
    const content = (await fn()).trim();
    return content ? { name, content } : null;
  } catch (err: any) {
    console.error(`[prep] source "${name}" failed:`, err.message);
    return null;
  }
}

/** Skips the source entirely (no attempt, no log) when this session has that tool turned off — same call shape as trySource, one extra arg. */
export function toolSource(
  ctx: Pick<WorkflowContext, 'activeTools'>,
  tool: ToolKey,
  name: string,
  fn: () => Promise<string>
): Promise<WorkflowSource | null> {
  return isToolActive(ctx.activeTools, tool) ? trySource(name, fn) : Promise.resolve(null);
}

export interface SourceSpec {
  tool: ToolKey;
  /** The sources_queried label, e.g. 'jira_recent_activity' — same strings every workflow already used before this was declarative. */
  name: string;
  /** Already-resolved query text — workflows compute this inline (a fixed phrase or searchTopic(ctx, ...)) before building the array. */
  query: string;
  limit?: number;
}

/**
 * Turns a declarative source list into the same toolSource(...) promises
 * workflows used to write by hand — the only thing this removes is the
 * fetch+format lambda per source, which now lives once in toolCatalog.ts
 * instead of copy-pasted per meeting type. Gating/failure-tolerance
 * (isToolActive, trySource's catch-and-drop) is unchanged.
 */
export function gatherToolSources(ctx: Pick<WorkflowContext, 'activeTools'>, specs: SourceSpec[]): Promise<WorkflowSource | null>[] {
  return specs.map((spec) => toolSource(ctx, spec.tool, spec.name, () => searchByTool(spec.tool, spec.query, spec.limit ?? 5)));
}

export async function gatherSources(attempts: Promise<WorkflowSource | null>[]): Promise<WorkflowResult> {
  const results = await Promise.all(attempts);
  return { sources: results.filter((r): r is WorkflowSource => !!r) };
}

/** The previous instance's summary + still-open action items, formatted as one block — shared by every workflow that wants "last time's notes." */
export async function previousSessionNotes(previousSession?: { id: string; name: string | null }): Promise<string> {
  if (!previousSession) return '';
  const summary = getSummary(previousSession.id);
  if (!summary) return '';
  const openItems = getActionItems(previousSession.id).filter((a) => a.status === 'open');
  const parts = [
    `Overview: ${summary.overview}`,
    `Key decisions: ${summary.keyDecisions}`,
    openItems.length ? `Still-open action items:\n${openItems.map((i) => `- ${i.description} (${i.owner || 'unowned'})`).join('\n')}` : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

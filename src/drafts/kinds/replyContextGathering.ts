import { config } from '../../config';
import { retrieve } from '../../rag/rag';
import { gatherSources, gatherToolSources, trySource, WorkflowSource } from '../../prep/workflows/types';
import { isToolActive } from '../../tools/activeTools';
import { looksCodeRelated } from '../../router';
import { extractIssueKeys } from '../../integrations/jiraMcp';
import { getActiveDevCycleForTicket } from '../../storage/devCycleRepository';
import { getRecentBuilds } from '../../integrations/jenkinsClient';
import { Task } from '../../storage/taskRepository';
import { ExternalMessage } from '../../storage/externalMessageRepository';

/**
 * Gathers grounding material for a reply draft (teams_reply/email_reply)
 * using the same tool-fanout machinery meeting-prep and Audio Overview
 * already use (gatherToolSources/trySource, src/prep/workflows/types.ts) —
 * gated by config.replyDraftToolKeys instead of a per-session activeTools
 * list, since a reply draft is keyed to a Task, not a session.
 *
 * Unlike Audio Overview's "query everything" shape, Bitbucket/local-code
 * search/Jenkins are gated behind looksCodeRelated(query) (src/router.ts,
 * the same heuristic prep's generic workflow and fact-check already use) —
 * a "sounds good, thanks!" reply shouldn't fire a code search.
 */
export async function gatherReplyContext(message: ExternalMessage | undefined, task: Task): Promise<string> {
  const query = message?.bodyText || task.description || task.title;
  const activeTools = config.replyDraftToolKeys;
  const ctx = { activeTools };
  const codeRelated = looksCodeRelated(query);

  const sources = [
    ...gatherToolSources(ctx, [
      { tool: 'jira', name: 'jira_context', query, limit: 5 },
      { tool: 'confluence', name: 'confluence_context', query, limit: 5 },
      { tool: 'mem0', name: 'mem0_context', query, limit: 5 },
      { tool: 'ragCloud', name: 'myrag_context', query, limit: 5 },
      { tool: 'email', name: 'email_history', query, limit: 5 },
      { tool: 'teams', name: 'teams_history', query, limit: 5 },
      { tool: 'webSearch', name: 'web_context', query },
      ...(codeRelated
        ? [
            { tool: 'bitbucket' as const, name: 'bitbucket_context', query, limit: 5 },
            { tool: 'localCodebase' as const, name: 'local_codebase_context', query, limit: 5 },
          ]
        : []),
    ]),
    trySource('past_meetings', async () => {
      const result = await retrieve(query);
      return result.suppressed ? '' : result.chunks.map((c) => `(${c.sessionName || 'a past session'}) ${c.text}`).join('\n');
    }),
  ];

  if (codeRelated && isToolActive(activeTools, 'bitbucket')) {
    sources.push(trySource('jenkins_context', () => gatherJenkinsContext(query)));
  }

  const { sources: gathered } = await gatherSources(sources);
  return formatSources(gathered);
}

/**
 * Best-effort only — Jenkins has no free-text search API (see
 * jenkinsClient.ts), so this only produces anything when the message
 * references a Jira ticket that already has a dev cycle with a resolved
 * Jenkins job path (src/dev/jenkinsMonitor.ts lazily resolves and caches
 * that mapping) — reuses that existing linkage rather than guessing which
 * repo/job a bare branch name might belong to.
 */
async function gatherJenkinsContext(query: string): Promise<string> {
  const keys = extractIssueKeys(query);
  for (const key of keys) {
    const cycle = getActiveDevCycleForTicket(key);
    if (!cycle?.jenkinsJobPath) continue;
    const builds = await getRecentBuilds(cycle.jenkinsJobPath, 1);
    if (!builds.length) continue;
    const build = builds[0];
    return `${key}'s branch (${cycle.branchName}): last build ${build.displayName} — ${build.building ? 'running' : build.result || 'unknown'}`;
  }
  return '';
}

function formatSources(sources: WorkflowSource[]): string {
  if (!sources.length) return '(nothing relevant found across configured tools or past meetings)';
  return sources.map((s) => `### ${s.name}\n${s.content}`).join('\n\n');
}

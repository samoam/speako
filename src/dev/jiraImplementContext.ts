import { DevPlanSeedContext, gatherPlanContext } from './devPlan';
import { isBitbucketConfigured, getPullRequestsForRole, BitbucketPullRequest } from '../integrations/bitbucketServer';
import { DevCycleAnalysisContext } from '../storage/devCycleRepository';

export interface RelatedPr {
  title: string;
  url: string;
  state: string;
}

/**
 * Related-PR lookup for the Jira-implement pipeline's Analyze step — reuses
 * getPullRequestsForRole (already exported for the PR-review flow's own
 * dashboard sync) rather than adding a new Bitbucket Server search call;
 * filters by ticket key appearing in the title or description, both roles
 * ('AUTHOR' and 'REVIEWER'), 'ALL' states so a merged/declined prior attempt
 * still shows up as history. De-duplicated by PR id in case the same PR
 * appears under both roles (e.g. the user both authored and later reviewed it).
 */
async function findRelatedPrs(ticketKey: string): Promise<RelatedPr[]> {
  if (!isBitbucketConfigured()) return [];
  const seen = new Set<number>();
  const related: RelatedPr[] = [];
  try {
    const [authored, reviewed] = await Promise.all([
      getPullRequestsForRole('AUTHOR', 'ALL'),
      getPullRequestsForRole('REVIEWER', 'ALL'),
    ]);
    const matchesTicket = (pr: BitbucketPullRequest) => `${pr.title} ${pr.description ?? ''}`.includes(ticketKey);
    for (const pr of [...authored, ...reviewed]) {
      if (!matchesTicket(pr) || seen.has(pr.id)) continue;
      seen.add(pr.id);
      related.push({ title: pr.title, url: pr.link, state: pr.state });
    }
  } catch (err: any) {
    console.error(`[jira-implement-context] related-PR lookup failed for ${ticketKey}:`, err.message);
  }
  return related;
}

/**
 * Analyze step's full context gather — everything gatherPlanContext already
 * does (Jira ticket detail, Confluence hits, local codebase search) plus
 * related Bitbucket PRs, persisted as DevCycleAnalysisContext
 * (dev_cycles.analysis_context) so it's shown in the Jira-implement tab
 * before/alongside the Plan step, and fed into both CLIs' plan prompts.
 */
export async function gatherJiraImplementContext(ticketKey: string, repoName: string): Promise<{ seed: DevPlanSeedContext; context: DevCycleAnalysisContext }> {
  const [seed, relatedPrs] = await Promise.all([gatherPlanContext(ticketKey, repoName), findRelatedPrs(ticketKey)]);
  const context: DevCycleAnalysisContext = {
    ticket: { key: seed.ticket.key, summary: seed.ticket.summary, status: seed.ticket.status, description: seed.ticket.description },
    confluencePages: seed.confluencePages.map((p) => ({ title: p.title })),
    codeHits: seed.codeHits.map((h) => ({ filePath: h.filePath })),
    relatedPrs,
  };
  return { seed, context };
}

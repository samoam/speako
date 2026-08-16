import { BitbucketPullRequest } from '../integrations/bitbucketServer';
import { isJiraConfigured, extractIssueKeys, getJiraIssueDetail, JiraIssueDetail } from '../integrations/jiraMcp';
import { isConfluenceConfigured, searchConfluence, getConfluencePage, ConfluencePage } from '../integrations/confluenceMcp';

export interface PrReviewContext {
  jiraIssues: JiraIssueDetail[];
  confluencePages: ConfluencePage[];
}

/**
 * Constrains the review agent's final answer to this exact shape (passed as
 * claudeCodeCli.ts's runClaudeCodeReview options.jsonSchema) — confirmed
 * live that --json-schema returns it already-parsed in structured_output,
 * no manual JSON.parse needed. Mirrors PrReviewFinding/StructuredReview in
 * src/storage/prReviewRequestRepository.ts; keep the two in sync by hand
 * (a JSON Schema object and a TS interface can't share one source here).
 */
export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'A short, simple story (2-4 sentences, plain language) connecting the Jira ticket\'s intent to what this PR actually does — what problem existed, and how this change addresses it. Not a line-by-line description of the diff.',
    },
    recommendation: {
      type: 'string',
      enum: ['approve', 'request_changes', 'comment'],
      description: '"approve" if safe to merge as-is, "request_changes" if a finding below is a blocker/major issue, "comment" for FYI-only findings with nothing blocking.',
    },
    findings: {
      type: 'array',
      description: 'Discrete, specific review comments — the same granularity a human reviewer would leave inline on the PR. Empty array if there is nothing to flag.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path of the file this finding is about, relative to the repo root.' },
          line: { type: ['integer', 'null'], description: 'The specific line number this finding is about, if it applies to one line — otherwise null.' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'], description: 'blocker = must fix before merge; major = should fix; minor = worth fixing but not urgent; nit = style/preference only.' },
          comment: { type: 'string', description: 'The actual review comment — specific and actionable, not a restatement of the code.' },
        },
        required: ['file', 'line', 'severity', 'comment'],
      },
    },
  },
  required: ['summary', 'recommendation', 'findings'],
};

const MAX_CONFLUENCE_PAGES = 2;

/**
 * Gathers the context a real reviewer would read first: any Jira ticket(s)
 * named in the PR title/description (full summary+description, not just
 * status), plus the top Confluence pages matching the first ticket's
 * summary (full body via getConfluencePage — searchConfluence's own
 * snippets are empty in practice against this Confluence instance, a
 * pre-existing gap, confirmed live). Per-item try/catch — one bad lookup
 * shouldn't block the rest, same resilience convention as every other
 * multi-source fetch in this codebase.
 */
export async function gatherReviewContext(pr: BitbucketPullRequest): Promise<PrReviewContext> {
  const jiraIssues: JiraIssueDetail[] = [];
  if (isJiraConfigured()) {
    const keys = extractIssueKeys(`${pr.title} ${pr.description ?? ''}`);
    for (const key of keys) {
      try {
        const detail = await getJiraIssueDetail(key);
        if (detail) jiraIssues.push(detail);
      } catch (err: any) {
        console.error(`[pr-review-context] failed to fetch Jira issue ${key}:`, err.message);
      }
    }
  }

  const confluencePages: ConfluencePage[] = [];
  if (isConfluenceConfigured() && jiraIssues.length > 0) {
    try {
      const matches = await searchConfluence(jiraIssues[0].summary, MAX_CONFLUENCE_PAGES);
      for (const match of matches) {
        if (!match.id) continue;
        try {
          confluencePages.push(await getConfluencePage(match.id));
        } catch (err: any) {
          console.error(`[pr-review-context] failed to fetch Confluence page ${match.id}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error('[pr-review-context] Confluence search failed:', err.message);
    }
  }

  return { jiraIssues, confluencePages };
}

/**
 * Builds the review prompt handed to `claude -p` (claudeCodeCli.ts's
 * runClaudeCodeReview) — the agent runs inside a worktree already checked
 * out to the PR's actual branch, so it explores the real code itself rather
 * than reviewing a diff string; this just supplies the "why" (ticket intent,
 * related docs) it can't get from the code alone.
 */
export function buildReviewPrompt(pr: BitbucketPullRequest, context: PrReviewContext): string {
  const sections = [
    `You are reviewing a Bitbucket pull request titled "${pr.title}".`,
    pr.description ? `PR description:\n${pr.description}` : null,
    context.jiraIssues.length
      ? `Linked Jira ticket(s):\n${context.jiraIssues.map((i) => `${i.key} [${i.status}]: ${i.summary}\n${i.description}`).join('\n\n')}`
      : null,
    context.confluencePages.length
      ? `Related documentation:\n${context.confluencePages.map((p) => `${p.title}:\n${p.content}`).join('\n\n')}`
      : null,
    `You are already on the PR's actual branch (checked out in this working directory) — explore the real codebase (related files, existing tests, call sites) rather than assuming from file names alone.

Follow a real code-review workflow: first understand *why* this change exists (the ticket's intent and any related documentation), then read the actual diff against the base branch, then check the surrounding code it touches — not just the changed lines in isolation.

Write a short, simple summary that tells the story of the ticket: what problem existed, and how this PR solves it — plain language, not a restatement of the diff.

Then leave specific, actionable findings the same way a human reviewer would leave inline PR comments — bugs, edge cases, missing test coverage, deviations from patterns already used elsewhere in this codebase. Each finding needs the exact file and line it's about (or null if it's not tied to one line) and a severity: blocker (must fix before merge), major (should fix), minor (worth fixing, not urgent), or nit (style/preference only). Be direct — this is for the author to act on, not a general description of what the diff does.`,
  ];
  return sections.filter(Boolean).join('\n\n');
}

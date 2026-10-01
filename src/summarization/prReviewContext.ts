import { BitbucketPullRequest, BitbucketPullRequestComment } from '../integrations/bitbucketServer';
import { isJiraConfigured, extractIssueKeys, getJiraIssueDetail, JiraIssueDetail } from '../integrations/jiraMcp';
import { isConfluenceConfigured, searchConfluence, getConfluencePage, ConfluencePage } from '../integrations/confluenceMcp';
import { StructuredReview, PrReviewRecommendation } from '../storage/prReviewRequestRepository';
import { generateJson } from '../ai/aiRouter';
import { askJev, isJevConfigured, jevChoice } from '../integrations/typesafeJev';
import { SPEAKO_COMMENT_MARKER } from './prReviewComments';

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
    // The branch name too — some PRs only carry the key there (e.g. "bugfix_ETICK-10230-…").
    const keys = extractIssueKeys(`${pr.title} ${pr.description ?? ''} ${pr.fromRefDisplayId ?? ''}`);
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
/** Caps how many existing comments get quoted into the prompt — a long-running PR can accumulate dozens, and only the gist (who said what) is needed to avoid restating it, not the full thread verbatim. */
const MAX_EXISTING_COMMENTS_IN_PROMPT = 40;

export function buildReviewPrompt(pr: BitbucketPullRequest, context: PrReviewContext, existingComments: BitbucketPullRequestComment[] = []): string {
  const sections = [
    `You are reviewing a Bitbucket pull request titled "${pr.title}", opened by ${pr.authorName}.`,
    pr.description ? `PR description:\n${pr.description}` : null,
    context.jiraIssues.length
      ? `Linked Jira ticket(s):\n${context.jiraIssues.map((i) => `${i.key} [${i.status}]: ${i.summary}\n${i.description}`).join('\n\n')}`
      : null,
    context.confluencePages.length
      ? `Related documentation:\n${context.confluencePages.map((p) => `${p.title}:\n${p.content}`).join('\n\n')}`
      : null,
    existingComments.length
      ? `Comments already on this PR (from a human reviewer, or "Speako" if left by a prior automated review) — do not raise a finding that just repeats one of these; only flag it again if it's still genuinely unaddressed in the current code:\n${existingComments
          .slice(0, MAX_EXISTING_COMMENTS_IN_PROMPT)
          .map((c) => `${c.text.includes(SPEAKO_COMMENT_MARKER) ? 'Speako (prior review)' : c.authorName}: ${c.text}`)
          .join('\n\n')}`
      : null,
    `You are already on the PR's actual branch (checked out in this working directory) — explore the real codebase (related files, existing tests, call sites) rather than assuming from file names alone.

Follow a real code-review workflow: first understand *why* this change exists (the ticket's intent and any related documentation), then read the actual diff against the base branch, then check the surrounding code it touches — not just the changed lines in isolation.

Write a short, simple summary that tells the story of the ticket: what problem existed, and how this PR solves it — plain language, not a restatement of the diff.

Then leave specific, actionable findings the same way a human reviewer would leave inline PR comments — bugs, edge cases, missing test coverage, deviations from patterns already used elsewhere in this codebase. Each finding needs the exact file and line it's about (or null if it's not tied to one line) and a severity: blocker (must fix before merge), major (should fix), minor (worth fixing, not urgent), or nit (style/preference only). Be direct — this is for the author to act on, not a general description of what the diff does.`,
  ];
  return sections.filter(Boolean).join('\n\n');
}

/**
 * Same as REVIEW_JSON_SCHEMA's findings, plus a required `source` per
 * finding — only meaningful for a merged review (mergeReviews below), so
 * it's kept as its own schema rather than added to REVIEW_JSON_SCHEMA
 * itself, which stays what runClaudeCodeReview constrains its solo output
 * to. Watermarks each finding with which reviewer(s) actually raised it
 * (index.html's finding cards surface this as a badge), rather than
 * presenting a merged review as if either agent had produced the whole
 * thing alone.
 */
const MERGE_REVIEW_JSON_SCHEMA = {
  ...REVIEW_JSON_SCHEMA,
  properties: {
    ...REVIEW_JSON_SCHEMA.properties,
    findings: {
      ...REVIEW_JSON_SCHEMA.properties.findings,
      items: {
        ...REVIEW_JSON_SCHEMA.properties.findings.items,
        properties: {
          ...REVIEW_JSON_SCHEMA.properties.findings.items.properties,
          source: {
            type: 'string',
            enum: ['claude', 'gemini', 'both'],
            description: '"claude" or "gemini" if only that reviewer raised this finding; "both" if it\'s a merge of matching findings from each.',
          },
        },
        required: [...REVIEW_JSON_SCHEMA.properties.findings.items.required, 'source'],
      },
    },
  },
};

/**
 * Combines claudeCodeCli.ts's structured review with the Antigravity CLI's
 * free-text one (antigravityCli.ts's runSecondOpinionReview) into a single
 * StructuredReview — used by server.ts whenever a second opinion actually
 * ran, so a PR gets the benefit of two independent agentic reviewers instead
 * of one. Goes through the Gemini API (not the second-opinion CLI itself,
 * which has no documented way to constrain its output to REVIEW_JSON_SCHEMA)
 * so the merged result still validates against the same schema every other
 * caller of runClaudeCodeReview's review path already expects (source is the
 * only addition, and it's optional on PrReviewFinding).
 */
export async function mergeReviews(claudeReview: StructuredReview, geminiReviewText: string): Promise<StructuredReview> {
  const prompt = `Two independent AI reviewers each reviewed the same pull request on their own, without seeing each other's output. Merge their findings into a single review a human reviewer can act on.

Reviewer A = "claude" (structured JSON):
${JSON.stringify(claudeReview, null, 2)}

Reviewer B = "gemini" (free-form text):
${geminiReviewText}

Merge rules:
- If both reviewers raised essentially the same issue (same file/area, same underlying problem), output ONE finding for it (source: "both"), folding in anything Reviewer B adds that Reviewer A didn't mention. Never list the same issue twice.
- Keep every distinct issue either reviewer raised, even one only a single reviewer caught (source: "claude" or "gemini" accordingly) — two independent reviewers catching different things is the entire point of running both.
- If the reviewers disagree on severity for the same issue, use the more cautious (higher) severity.
- recommendation: "request_changes" if either reviewer flagged a blocker/major issue, "approve" only if both are effectively clean, "comment" otherwise.
- Write one combined summary in the same short, plain-language style as Reviewer A's summary — synthesize, don't just concatenate the two.`;

  const parsed = await generateJson<any>('reviewMerge', 'mergePrReviews', prompt, MERGE_REVIEW_JSON_SCHEMA);
  return {
    summary: parsed.summary || claudeReview.summary,
    recommendation: parsed.recommendation || claudeReview.recommendation,
    findings: Array.isArray(parsed.findings) ? parsed.findings : claudeReview.findings,
  };
}

const RECOMMENDATIONS = ['approve', 'request_changes', 'comment'] as const;

/**
 * Jev's pick for the review decision, read from the finished review's own
 * summary and findings — the same inputs REVIEW_JSON_SCHEMA's recommendation
 * rule is defined over. Null (keep the reviewer's own pick) when Jev isn't
 * configured, fails, or answers outside the three options.
 */
export async function recommendWithJev(review: StructuredReview): Promise<PrReviewRecommendation | null> {
  if (!isJevConfigured()) return null;
  const findings = review.findings.length
    ? review.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.comment}`).join('\n')
    : '(no findings)';
  try {
    const answers = await askJev(`Pull request review summary:\n${review.summary}\n\nFindings:\n${findings}`, {
      recommendation: {
        type: 'choice',
        instructions: 'What should the reviewer do with this pull request, given the review above?',
        criteria: {
          approve: 'Safe to merge as-is — no blocker or major finding',
          request_changes: 'At least one finding is a blocker or major issue that must be fixed before merge',
          comment: 'Only minor/nit findings worth mentioning, nothing blocking',
        },
      },
    }, 'prRecommendation');
    return jevChoice(answers.recommendation, RECOMMENDATIONS);
  } catch (err: any) {
    console.error("[pr-review] Jev recommendation failed, keeping the reviewer's own:", err.message);
    return null;
  }
}

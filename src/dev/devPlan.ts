import { JiraIssueDetail, getJiraIssueDetail, isJiraConfigured } from '../integrations/jiraMcp';
import { ConfluencePage, searchConfluence, getConfluencePage, isConfluenceConfigured } from '../integrations/confluenceMcp';
import { searchCode, CodeMatch } from '../codebase/searchCode';

export interface DevPlanFileChange {
  path: string;
  action: 'modify' | 'create' | 'delete';
  why: string;
}

export interface DevPlanRisk {
  risk: string;
  mitigation: string;
  severity: 'high' | 'medium' | 'low';
}

/** The plan-before-code agent's structured output — see buildPlanPrompt() and its dispatch via the existing runClaudeCodeReview (already read-only/schema-constrained). */
export interface StructuredDevPlan {
  understanding: string;
  approach: string;
  files: DevPlanFileChange[];
  tests: string[];
  risks: DevPlanRisk[];
  openQuestions: string[];
  estimatedSize: 'xs' | 's' | 'm' | 'l' | 'xl';
}

export const DEV_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    understanding: { type: 'string', description: '2-4 sentences: what the ticket actually asks for, in plain language.' },
    approach: { type: 'string', description: 'How you intend to implement it, referencing the real files/patterns you found in this codebase.' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path of a file you expect to touch. Must be a path you actually verified exists, unless action is "create".' },
          action: { type: 'string', enum: ['modify', 'create', 'delete'] },
          why: { type: 'string' },
        },
        required: ['path', 'action', 'why'],
      },
    },
    tests: { type: 'array', items: { type: 'string' }, description: 'Specific tests to add/update, naming the real test files and conventions you found in this codebase.' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          risk: { type: 'string' },
          mitigation: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['risk', 'mitigation', 'severity'],
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'Things you could not determine from the code and that a human must answer. Empty array if none.' },
    estimatedSize: { type: 'string', enum: ['xs', 's', 'm', 'l', 'xl'] },
  },
  required: ['understanding', 'approach', 'files', 'tests', 'risks', 'openQuestions', 'estimatedSize'],
};

export interface DevPlanSeedContext {
  ticket: JiraIssueDetail;
  confluencePages: ConfluencePage[];
  codeHits: CodeMatch[];
}

const MAX_CONFLUENCE_PAGES = 2;
const MAX_CODE_HITS = 8;

/**
 * Grounding pass before the agent runs — same shape as prReviewContext.ts's
 * gatherReviewContext (Jira ticket + top Confluence matches), plus an
 * embedding search over the already-indexed local codebase (src/codebase/)
 * so the prompt can point the agent at real candidate files up front rather
 * than starting from nothing.
 */
export async function gatherPlanContext(ticketKey: string, repoName: string): Promise<DevPlanSeedContext> {
  if (!isJiraConfigured()) throw new Error('Jira is not configured — see NOTES.md.');
  const ticket = await getJiraIssueDetail(ticketKey);
  if (!ticket) throw new Error(`Jira issue ${ticketKey} was not found.`);

  const confluencePages: ConfluencePage[] = [];
  if (isConfluenceConfigured()) {
    try {
      const matches = await searchConfluence(ticket.summary, MAX_CONFLUENCE_PAGES);
      for (const match of matches) {
        if (!match.id) continue;
        try {
          confluencePages.push(await getConfluencePage(match.id));
        } catch (err: any) {
          console.error(`[dev-plan] failed to fetch Confluence page ${match.id}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error('[dev-plan] Confluence search failed:', err.message);
    }
  }

  let codeHits: CodeMatch[] = [];
  try {
    codeHits = (await searchCode(`${ticket.summary}\n${ticket.description}`, MAX_CODE_HITS)).filter((h) => h.repoName === repoName);
  } catch (err: any) {
    console.error('[dev-plan] local codebase search failed:', err.message);
  }

  return { ticket, confluencePages, codeHits };
}

/**
 * Prompt for the plan-before-code step — dispatched via the existing
 * runClaudeCodeReview (claudeCodeCli.ts), already read-only
 * (--permission-mode plan, Write/Edit disallowed) and already
 * schema-constrained via --json-schema, so no new CLI plumbing is needed for
 * this step at all. Mirrors buildReviewPrompt's tone (prReviewContext.ts).
 */
export function buildPlanPrompt(ctx: DevPlanSeedContext, opts?: { previousPlan?: StructuredDevPlan; feedback?: string; returnReason?: string }): string {
  const sections = [
    `You are planning the implementation of Jira ticket ${ctx.ticket.key} [${ctx.ticket.status}]: ${ctx.ticket.summary}`,
    ctx.ticket.description ? `Ticket description:\n${ctx.ticket.description}` : null,
    ctx.confluencePages.length
      ? `Related documentation:\n${ctx.confluencePages.map((p) => `${p.title}:\n${p.content}`).join('\n\n')}`
      : null,
    ctx.codeHits.length
      ? `Candidate files found by an embedding search over this codebase (verify these are actually relevant — don't just trust the search):\n${ctx.codeHits.map((h) => `${h.filePath}:\n${h.text.slice(0, 400)}`).join('\n\n')}`
      : null,
    opts?.returnReason ? `This ticket was previously sent back by QA. Reason: ${opts.returnReason}\n\nYour plan must account for this — do not repeat the same approach without addressing the rejection reason.` : null,
    opts?.previousPlan && opts?.feedback
      ? `A previous plan attempt was made:\n${JSON.stringify(opts.previousPlan, null, 2)}\n\nThe developer's feedback on it: ${opts.feedback}\n\nProduce a revised plan addressing that feedback.`
      : null,
    `You are in a worktree already checked out on this ticket's branch — read the real code before proposing anything; every file path you name must be one you actually verified (via Read/Grep/Glob), not guessed from the search results alone.

Do NOT write any code — this is a plan for a human to approve before any implementation starts. If the ticket is ambiguous or you can't determine something from the code, say so in openQuestions rather than guessing. Be specific about files, not just areas of the codebase.`,
  ];
  return sections.filter(Boolean).join('\n\n');
}

export type BranchType = 'feature' | 'bugfix' | 'hotfix' | 'chore';

/**
 * Jira issue type -> default branch type. 'hotfix' is never auto-derived —
 * it implies branching off something other than trunk, which is always an
 * explicit human choice, never inferred from an issue type name.
 */
export function branchTypeForIssueType(issueType: string): BranchType {
  const normalized = issueType.trim().toLowerCase();
  if (['bug', 'defect'].includes(normalized)) return 'bugfix';
  if (['task', 'chore', 'sub-task', 'subtask'].includes(normalized)) return 'chore';
  return 'feature'; // Story, Improvement, New Feature, Epic, and anything unrecognized
}

/**
 * lowercase -> strip a leading "KEY-123:"/"KEY-123 " prefix (redundant once
 * the ticket key is already the branch prefix) -> strip bracketed tags like
 * "[BE]" -> non-alnum to '-' -> collapse/trim '-' -> truncate at the last
 * '-' before maxLength (never mid-word). Falls back to 'changes' rather than
 * producing an empty slug.
 */
export function slugify(summary: string, maxLength = 40): string {
  let s = summary.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9]{1,9}-\d+[:\s-]*/i, '');
  s = s.replace(/^\s*\[[^\]]*\]\s*/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) return 'changes';
  if (s.length <= maxLength) return s;
  const truncated = s.slice(0, maxLength);
  const lastDash = truncated.lastIndexOf('-');
  return (lastDash > 0 ? truncated.slice(0, lastDash) : truncated).replace(/-+$/, '') || 'changes';
}

/** `<type>/<TICKET-ID>-<slug>`, capped at 100 chars total — the branch-naming convention every dev-cycle branch follows (see the blueprint's §5.3). */
export function buildBranchName(params: { type: BranchType; ticketKey: string; summary: string }): string {
  const prefix = `${params.type}/${params.ticketKey.toUpperCase()}-`;
  const slug = slugify(params.summary, Math.max(10, 100 - prefix.length));
  return `${prefix}${slug}`.slice(0, 100);
}

const TICKET_IN_BRANCH = /(?:^|\/)([A-Z][A-Z0-9]{1,9}-\d+)(?:-|$)/;

/** The auto-link primitive: PR branch name -> ticket key, per the naming convention above. Null if the branch doesn't follow it. */
export function extractTicketKeyFromBranch(branch: string): string | null {
  const match = branch.match(TICKET_IN_BRANCH);
  return match ? match[1] : null;
}

const BRANCH_PATTERN = /^(feature|bugfix|hotfix|chore)\/([A-Z][A-Z0-9]{1,9}-\d+)-(.+)$/;

export function parseBranchName(branch: string): { type: BranchType; ticketKey: string; slug: string } | null {
  const match = branch.match(BRANCH_PATTERN);
  if (!match) return null;
  return { type: match[1] as BranchType, ticketKey: match[2], slug: match[3] };
}

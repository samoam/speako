import { PrReviewFinding, PrReviewSeverity } from '../storage/prReviewRequestRepository';
import { DiffAnchor, BitbucketCommentAnchor } from '../integrations/bitbucketServer';

export interface StagedPrComment {
  findingIndex: number;
  file: string;
  line: number | null;
  severity: PrReviewSeverity;
  text: string;
  mode: 'inline' | 'file' | 'general';
  anchor: BitbucketCommentAnchor | null;
  anchorWarning: string | null;
}

/** The posted body — always carries a trailer identifying it as AI-drafted, never posted as if a human wrote it unaided. */
export function formatFindingComment(finding: PrReviewFinding): string {
  return `**${finding.severity}** — ${finding.comment}\n\n_Drafted by Speako from an automated review; reviewed and posted by a human._`;
}

export interface ResolvedAnchor {
  mode: 'inline' | 'file' | 'general';
  anchor: BitbucketCommentAnchor | null;
  warning: string | null;
}

/**
 * Exact (path, line) match against the PR's real diff -> inline comment.
 * Path is in the diff but that exact line isn't (e.g. the finding cites a
 * line just outside the changed hunk, or has no line at all) -> file-level
 * comment, with a warning. Path isn't part of this PR's diff at all (a
 * hallucinated or stale file reference) -> a general PR comment prefixed
 * with the path so it's still traceable.
 */
export function resolveFindingAnchor(finding: PrReviewFinding, changedPaths: string[], anchors: DiffAnchor[]): ResolvedAnchor {
  const pathChanged = changedPaths.includes(finding.file);

  if (finding.line != null) {
    const match = anchors.find((a) => a.line === finding.line);
    if (match) {
      return { mode: 'inline', anchor: { path: finding.file, line: match.line, lineType: match.lineType, fileType: match.fileType, diffType: 'EFFECTIVE' }, warning: null };
    }
    if (pathChanged) {
      return { mode: 'file', anchor: { path: finding.file, diffType: 'EFFECTIVE', fileType: 'TO' }, warning: `line ${finding.line} is outside this PR's diff — posting as a file comment` };
    }
  } else if (pathChanged) {
    return { mode: 'file', anchor: { path: finding.file, diffType: 'EFFECTIVE', fileType: 'TO' }, warning: null };
  }

  return { mode: 'general', anchor: null, warning: pathChanged ? null : `"${finding.file}" isn't one of this PR's changed files` };
}

/** Maps every finding in a review to a stageable comment — one row per finding, in the same order. `anchorsByPath` should have one entry per distinct finding.file already fetched via getPullRequestDiffAnchors. */
export function stagePrReviewComments(findings: PrReviewFinding[], changedPaths: string[], anchorsByPath: Map<string, DiffAnchor[]>): StagedPrComment[] {
  return findings.map((finding, findingIndex) => {
    const { mode, anchor, warning } = resolveFindingAnchor(finding, changedPaths, anchorsByPath.get(finding.file) ?? []);
    const body = formatFindingComment(finding);
    const text = mode === 'general' ? `\`${finding.file}${finding.line != null ? ':' + finding.line : ''}\` — ${body}` : body;
    return { findingIndex, file: finding.file, line: finding.line, severity: finding.severity, text, mode, anchor, anchorWarning: warning };
  });
}

/** Used when a posted comment turns out to be wrong/unhelpful and a hard delete isn't possible (or isn't what the developer wants) — a reply on the original comment, not a silent edit, so the audit trail of what was actually said stays intact. */
export function formatRetractionComment(original: Pick<StagedPrComment, 'file' | 'line'>, reason: string): string {
  return `Retracting my earlier comment on \`${original.file}${original.line != null ? ':' + original.line : ''}\` — ${reason}`;
}

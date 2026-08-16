import { config } from '../config';
import { getBranchDiffStat, getBranchDiff } from '../integrations/gitBranches';
import { git } from '../integrations/claudeCodeCli';
import { getLatestBuildForJob } from '../storage/jenkinsBuildRepository';

export type CheckId = 'pr_size' | 'debug_leftovers' | 'tests' | 'trunk_drift' | 'build';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface DeterministicCheckResult {
  id: CheckId;
  status: CheckStatus;
  title: string;
  detail: string;
  evidence: string[];
}

function groupByTopLevelDir(files: string[]): string[] {
  const byDir = new Map<string, number>();
  for (const f of files) {
    const dir = f.includes('/') ? f.split('/')[0] : '(root)';
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  return [...byDir.entries()].map(([dir, count]) => `${dir}/ (${count} file${count === 1 ? '' : 's'})`);
}

const DEBUG_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b/, label: 'TODO/FIXME/XXX/HACK marker' },
  { pattern: /console\.(log|debug)\s*\(/, label: 'console.log/debug' },
  { pattern: /\bdebugger\b/, label: 'debugger statement' },
  { pattern: /\.only\s*\(/, label: '.only( — a scoped-to-one test call' },
  { pattern: /\bfdescribe\b|\bfit\s*\(/, label: 'fdescribe/fit — a focused test' },
  { pattern: /System\.out\.print|printStackTrace/, label: 'System.out.print/printStackTrace' },
];

/** Scans ADDED lines only (diff lines starting with a single '+', excluding the '+++' file header) — a leftover marker already present before this branch touched the file isn't this branch's problem to flag. */
function findDebugLeftovers(diff: string): string[] {
  const evidence: string[] = [];
  let currentFile = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentFile = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('++')) continue;
    for (const { pattern, label } of DEBUG_PATTERNS) {
      if (pattern.test(line)) {
        evidence.push(`${currentFile}: ${label}`);
        break;
      }
    }
  }
  return evidence;
}

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__)\//i;
const TEST_NAME_PATTERN = /\.(test|spec)\./i;

function isTestFile(path: string): boolean {
  return TEST_PATH_PATTERN.test(path) || TEST_NAME_PATTERN.test(path);
}

function baseName(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.(test|spec)\./i, '.').replace(/\.[^.]+$/, '');
}

/** Heuristic, not proof: a changed source file with no changed test file sharing its base name AND no changed file under a test directory at all is flagged — a config-only change legitimately has neither, hence 'warn' not 'fail'. */
function findMissingTestCoverage(files: string[]): string[] {
  const testFiles = files.filter(isTestFile);
  const testBaseNames = new Set(testFiles.map(baseName));
  const sourceFiles = files.filter((f) => !isTestFile(f));
  return sourceFiles.filter((f) => !testBaseNames.has(baseName(f)));
}

async function countCommitsBehindTrunk(worktreePath: string, baseBranch: string): Promise<number> {
  const output = await git(['rev-list', '--count', `HEAD..origin/${baseBranch}`], worktreePath);
  const count = Number(output.trim());
  return Number.isFinite(count) ? count : 0;
}

const TRUNK_DRIFT_WARN_THRESHOLD = 20;

/**
 * No-LLM checks against the cycle's own worktree — cheap, exact, and (per
 * the blueprint) never delegated to an LLM: diff size, leftover-marker scan,
 * test-coverage heuristic, trunk drift. The `build` check is 'skipped'
 * unless a Jenkins job is configured for this cycle (jenkinsJobPath) —
 * nothing here depends on the Jenkins integration otherwise.
 */
export async function runDeterministicChecks(worktreePath: string, baseBranch: string, jenkinsJobPath?: string | null): Promise<DeterministicCheckResult[]> {
  const results: DeterministicCheckResult[] = [];

  const stat = await getBranchDiffStat(worktreePath, baseBranch);
  const totalLines = stat.insertions + stat.deletions;
  if (stat.files.length > config.prePrMaxChangedFiles || totalLines > config.prePrMaxChangedLines) {
    results.push({
      id: 'pr_size',
      status: 'warn',
      title: 'This PR may be large enough to split',
      detail: `${stat.files.length} files changed, +${stat.insertions}/-${stat.deletions} lines.`,
      evidence: groupByTopLevelDir(stat.files),
    });
  } else {
    results.push({ id: 'pr_size', status: 'pass', title: 'PR size', detail: `${stat.files.length} files changed, +${stat.insertions}/-${stat.deletions} lines.`, evidence: [] });
  }

  const diff = await getBranchDiff(worktreePath, baseBranch);
  const leftovers = findDebugLeftovers(diff);
  results.push(
    leftovers.length
      ? { id: 'debug_leftovers', status: 'warn', title: 'Possible debug leftovers', detail: `${leftovers.length} suspicious line(s) in the added code.`, evidence: leftovers }
      : { id: 'debug_leftovers', status: 'pass', title: 'No debug leftovers found', detail: '', evidence: [] }
  );

  const missingTests = findMissingTestCoverage(stat.files);
  results.push(
    missingTests.length
      ? { id: 'tests', status: 'warn', title: 'Some changed files have no matching test change', detail: 'A config-only change legitimately has none — use judgement.', evidence: missingTests }
      : { id: 'tests', status: 'pass', title: 'Test coverage looks reasonable', detail: '', evidence: [] }
  );

  const behind = await countCommitsBehindTrunk(worktreePath, baseBranch);
  results.push(
    behind > TRUNK_DRIFT_WARN_THRESHOLD
      ? { id: 'trunk_drift', status: 'warn', title: 'Branch is significantly behind trunk', detail: `${behind} commits behind ${baseBranch} — consider merging trunk in before opening.`, evidence: [] }
      : { id: 'trunk_drift', status: 'pass', title: 'Up to date with trunk', detail: `${behind} commit(s) behind ${baseBranch}.`, evidence: [] }
  );

  if (jenkinsJobPath) {
    const build = getLatestBuildForJob(jenkinsJobPath);
    if (!build || build.building) {
      results.push({ id: 'build', status: 'warn', title: 'Build status', detail: build ? 'Latest build is still running.' : 'No build observed yet for this branch.', evidence: [] });
    } else if (build.result === 'SUCCESS') {
      results.push({ id: 'build', status: 'pass', title: 'Build status', detail: `Build #${build.buildNumber} passed.`, evidence: [] });
    } else {
      results.push({ id: 'build', status: 'fail', title: 'Build status', detail: `Build #${build.buildNumber} ${build.result ?? 'failed'}.`, evidence: build.classification ? [build.classification] : [] });
    }
  } else {
    results.push({ id: 'build', status: 'skipped', title: 'Build status', detail: 'Jenkins integration not configured for this branch yet.', evidence: [] });
  }

  return results;
}

export interface AcceptanceCriterionCheck {
  criterion: string;
  covered: boolean;
  evidence: string;
}
export interface ScopeCreepItem {
  file: string;
  why: string;
}
export interface TestGapItem {
  path: string;
  why: string;
}
export interface SplitSuggestion {
  shouldSplit: boolean;
  rationale: string;
  proposedSplits: string[];
}
export type PrePrVerdict = 'ready' | 'gaps' | 'blocked';

export interface PrePrAgentResult {
  acceptanceCriteria: AcceptanceCriterionCheck[];
  scopeCreep: ScopeCreepItem[];
  testGaps: TestGapItem[];
  splitSuggestion: SplitSuggestion;
  verdict: PrePrVerdict;
  summary: string;
  /** Blueprint §5.1 step 6: does this change affect behavior, architecture, or a runbook enough to warrant a Confluence update? Drives prOpenDraft.ts's auto-trigger of confluence_dev_cycle_update. */
  confluenceRelevant: boolean;
  confluenceReason: string;
}

/** Constrains the self-review agent's final answer (passed as runClaudeCodeReview's options.jsonSchema, same mechanism as devPlan.ts/prReviewContext.ts). */
export const PRE_PR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'object', properties: { criterion: { type: 'string' }, covered: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['criterion', 'covered', 'evidence'] },
    },
    scopeCreep: {
      type: 'array',
      description: 'Changes not obviously required by the ticket\'s acceptance criteria — flagged, not blocked, per the blueprint (scope creep is reported, never silently removed).',
      items: { type: 'object', properties: { file: { type: 'string' }, why: { type: 'string' } }, required: ['file', 'why'] },
    },
    testGaps: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'why'] },
    },
    splitSuggestion: {
      type: 'object',
      properties: { shouldSplit: { type: 'boolean' }, rationale: { type: 'string' }, proposedSplits: { type: 'array', items: { type: 'string' } } },
      required: ['shouldSplit', 'rationale', 'proposedSplits'],
    },
    verdict: {
      type: 'string',
      enum: ['ready', 'gaps', 'blocked'],
      description: '"ready" if the diff matches the ticket with no real gaps. "gaps" for non-blocking issues (missing tests, minor scope creep) worth a warning banner. "blocked" only for a clear acceptance-criterion miss or something that should not ship as-is.',
    },
    summary: { type: 'string', description: 'One short paragraph a human can read before deciding whether to open the PR.' },
    confluenceRelevant: {
      type: 'boolean',
      description: 'True if this change affects behavior, architecture, or a runbook enough that a Confluence page should be created/updated to document it. False for routine bug fixes, refactors, or changes with no user/architecture-visible effect.',
    },
    confluenceReason: { type: 'string', description: 'One sentence explaining the confluenceRelevant judgment.' },
  },
  required: ['acceptanceCriteria', 'scopeCreep', 'testGaps', 'splitSuggestion', 'verdict', 'summary', 'confluenceRelevant', 'confluenceReason'],
};

/** Deterministic findings are fed in as facts, not re-derived — the agent judges against the ticket's intent, which is exactly the part that can't be checked mechanically. */
export function buildPrePrPrompt(params: { ticketSummary: string; ticketDescription: string; deterministic: DeterministicCheckResult[] }): string {
  const findingsText = params.deterministic
    .map((c) => `- ${c.title} [${c.status}]${c.detail ? `: ${c.detail}` : ''}`)
    .join('\n');
  return `You are doing a pre-PR self-review before this branch's changes are opened as a pull request.

Ticket: ${params.ticketSummary}
${params.ticketDescription ? `Description:\n${params.ticketDescription}` : ''}

Deterministic checks already run against this branch's diff (treat these as facts, don't re-derive them):
${findingsText}

Read the actual diff against the base branch and the surrounding code. Judge: does this diff match the ticket's acceptance criteria — nothing more, nothing less? Flag scope creep, don't block on it. Are there real test gaps beyond what the deterministic check already found? Is this PR small enough to review in one sitting, or should it be split (e.g. infra/config changes separate from feature logic)? Finally, does this change affect behavior, architecture, or a runbook enough that a Confluence page should document it — as opposed to a routine bug fix or refactor with nothing new to document?

Do not write any code — this is a review, not an implementation step.`;
}

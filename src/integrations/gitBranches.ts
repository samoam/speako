import * as os from 'os';
import * as path from 'path';
import { git } from './claudeCodeCli';

// Fetch + worktree-add against a real remote can take meaningfully longer
// than a small local git call — same rationale/value as claudeCodeCli.ts's
// WORKTREE_CHECKOUT_TIMEOUT_MS, which this mirrors rather than imports
// (that constant isn't exported, and duplicating a single number here is
// cheaper than widening that module's exports for it).
const GIT_NETWORK_TIMEOUT_MS = 5 * 60 * 1000;

export async function branchExistsOnRemote(repoPath: string, branch: string): Promise<boolean> {
  const output = await git(['ls-remote', '--heads', 'origin', branch], repoPath, GIT_NETWORK_TIMEOUT_MS);
  return output.trim().length > 0;
}

/**
 * Creates the ticket branch off trunk AND its own long-lived worktree in one
 * step — deliberately a worktree, never a checkout in repoPath itself, for
 * the same reason claudeCodeCli.ts's startClaudeCodeTask never touches the
 * user's own working directory: nothing Speako does here may disturb
 * whatever the user has checked out/in progress in their real repo folder.
 * This worktree is long-lived for the whole dev cycle (branch creation,
 * every plan/implement round, every Return loop) — never removed except
 * when the cycle itself closes (see closeDevCycle's cleanup).
 */
export async function createTicketBranchWorktree(repoPath: string, branch: string, baseBranch: string): Promise<string> {
  await git(['fetch', 'origin', baseBranch], repoPath, GIT_NETWORK_TIMEOUT_MS);
  const worktreePath = path.join(os.tmpdir(), `speako-dev-cycle-${branch.replace(/[/\\]/g, '-')}-${Date.now()}`);
  await git(['worktree', 'add', '-b', branch, worktreePath, `origin/${baseBranch}`], repoPath, GIT_NETWORK_TIMEOUT_MS);
  return worktreePath;
}

export interface BranchDiffStat {
  files: string[];
  insertions: number;
  deletions: number;
}

export async function getBranchDiffStat(worktreePath: string, baseBranch: string): Promise<BranchDiffStat> {
  const nameOutput = await git(['diff', '--name-only', `origin/${baseBranch}...HEAD`], worktreePath);
  const files = nameOutput.split('\n').map((s) => s.trim()).filter(Boolean);
  const numstatOutput = await git(['diff', '--numstat', `origin/${baseBranch}...HEAD`], worktreePath);
  let insertions = 0;
  let deletions = 0;
  for (const line of numstatOutput.split('\n')) {
    const [add, del] = line.trim().split(/\s+/);
    if (Number.isFinite(Number(add))) insertions += Number(add);
    if (Number.isFinite(Number(del))) deletions += Number(del);
  }
  return { files, insertions, deletions };
}

export async function getBranchDiff(worktreePath: string, baseBranch: string): Promise<string> {
  return git(['diff', `origin/${baseBranch}...HEAD`], worktreePath, GIT_NETWORK_TIMEOUT_MS);
}

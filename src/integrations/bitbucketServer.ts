import { config } from '../config';

export interface BitbucketMatch {
  path: string;
  snippet: string;
}

function authHeader(): string {
  const basic = Buffer.from(`${config.bitbucketServerUsername}:${config.bitbucketServerToken}`).toString('base64');
  return `Basic ${basic}`;
}

export function isBitbucketConfigured(): boolean {
  return !!(
    config.bitbucketServerUrl &&
    config.bitbucketServerUsername &&
    config.bitbucketServerToken &&
    config.bitbucketServerRepos.length > 0
  );
}

const REQUEST_TIMEOUT_MS = 15_000;

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${config.bitbucketServerUrl}${path}`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Bitbucket Server request failed: ${res.status} ${res.statusText} — ${path}`);
  }
  return res.json();
}

/**
 * First write path in this file (everything above was read-only) — sibling
 * of apiGet using the same auth/timeout, for POST/PUT/DELETE. Bitbucket
 * Server's error responses carry a JSON `{errors: [{message, ...}]}` body;
 * surfaced here so a 400/409 reads as an actual reason ("branch not found",
 * "PR already exists") rather than a bare status code.
 */
async function apiSend(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<any> {
  const res = await fetch(`${config.bitbucketServerUrl}${path}`, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errJson: any = await res.json();
      detail = (errJson?.errors ?? []).map((e: any) => e.message).filter(Boolean).join('; ');
    } catch {
      // Body wasn't JSON — fall back to the generic status-based message below.
    }
    throw new Error(`Bitbucket Server request failed: ${res.status} ${res.statusText} — ${path}${detail ? ` (${detail})` : ''}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Follows Bitbucket Server's standard {values, isLastPage, nextPageStart} paging shape until exhausted or maxItems is reached. */
async function apiGetAllPages(path: string, maxItems = 200): Promise<any[]> {
  const items: any[] = [];
  let start = 0;
  while (items.length < maxItems) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await apiGet(`${path}${sep}start=${start}`);
    items.push(...(page.values ?? []));
    if (page.isLastPage || !page.values?.length) break;
    start = page.nextPageStart ?? start + page.values.length;
  }
  return items.slice(0, maxItems);
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  state: string;
  projectKey: string;
  repoSlug: string;
  authorName: string;
  link: string;
  /** Only present when this PR was fetched with role=REVIEWER and the caller's own review status could be identified. */
  myApprovalStatus?: string;
  /** Epoch-derived ISO timestamp, same conversion as BitbucketPullRequestComment.createdDate — used by the orchestrator's task scoring to age a still-open review request. Null if Bitbucket's response omits it (shouldn't happen in practice, defensive only). */
  createdDate: string | null;
  /** PR description body — used by the PR-review flow to find linked Jira keys, alongside the title. */
  description: string | null;
  /** Source/target branch short names (e.g. "feature/foo"/"main") — Bitbucket's response always includes these, but no consumer needed them until the PR-review flow's real branch checkout. */
  fromRefDisplayId: string | null;
  toRefDisplayId: string | null;
}

function mapPullRequest(raw: any): BitbucketPullRequest {
  const myReviewer = (raw.reviewers ?? []).find(
    (p: any) => p?.user?.name?.toLowerCase() === config.bitbucketServerUsername.toLowerCase()
  );
  return {
    id: raw.id,
    title: raw.title,
    state: raw.state,
    projectKey: raw.toRef?.repository?.project?.key ?? '',
    repoSlug: raw.toRef?.repository?.slug ?? '',
    authorName: raw.author?.user?.displayName ?? raw.author?.user?.name ?? 'unknown',
    link: raw.links?.self?.[0]?.href ?? '',
    myApprovalStatus: myReviewer?.status,
    createdDate: raw.createdDate ? new Date(raw.createdDate).toISOString() : null,
    description: raw.description ?? null,
    fromRefDisplayId: raw.fromRef?.displayId ?? null,
    toRefDisplayId: raw.toRef?.displayId ?? null,
  };
}

/** The dashboard/PR-list endpoints never include the full description — only single-PR fetches do. Used by the PR-review flow to learn the actual branch to check out and gather Jira/Confluence context from the description. */
export async function getPullRequest(projectKey: string, repoSlug: string, pullRequestId: number): Promise<BitbucketPullRequest> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }
  const raw = await apiGet(`/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${pullRequestId}`);
  return mapPullRequest(raw);
}

/**
 * Bitbucket Server's /dashboard/pull-requests endpoint is repo-agnostic —
 * it returns PRs across every repo the authenticated user (whichever
 * account bitbucketServerUsername/Token belong to) can see, scoped by their
 * role on each PR. Unlike searchBitbucketServer above, this doesn't need
 * config.bitbucketServerRepos at all.
 */
export async function getPullRequestsForRole(role: 'REVIEWER' | 'AUTHOR', state: 'OPEN' | 'ALL' = 'OPEN'): Promise<BitbucketPullRequest[]> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }
  const raw = await apiGetAllPages(`/rest/api/1.0/dashboard/pull-requests?role=${role}&state=${state}&limit=50`);
  return raw.map(mapPullRequest);
}

export interface BitbucketPullRequestComment {
  prId: number;
  prTitle: string;
  projectKey: string;
  repoSlug: string;
  authorName: string;
  text: string;
  createdDate: string;
}

/** activities includes comments, approvals, merges, etc. — filtered to COMMENTED here since that's the only action type with free-text worth surfacing. */
export async function getPullRequestComments(pr: Pick<BitbucketPullRequest, 'id' | 'title' | 'projectKey' | 'repoSlug'>): Promise<BitbucketPullRequestComment[]> {
  const raw = await apiGetAllPages(
    `/rest/api/1.0/projects/${encodeURIComponent(pr.projectKey)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/activities?limit=50`,
    100
  );
  return raw
    .filter((a) => a.action === 'COMMENTED' && a.comment?.text)
    .map((a) => ({
      prId: pr.id,
      prTitle: pr.title,
      projectKey: pr.projectKey,
      repoSlug: pr.repoSlug,
      authorName: a.comment.author?.displayName ?? a.comment.author?.name ?? 'unknown',
      text: a.comment.text,
      createdDate: new Date(a.createdDate).toISOString(),
    }));
}

/** Matches a "path/like/this.ext" style token in free text, if the query names a specific file. */
function extractFilePath(text: string): string | null {
  const match = text.match(/\b[\w-]+(?:\/[\w.-]+)+\.[a-zA-Z0-9]+\b/);
  return match ? match[0] : null;
}

/**
 * This Bitbucket Server instance has no working server-wide code search
 * (verified: the REST search endpoint 500s, and the same is broken in the
 * web UI — not something a client-side fix can work around). So instead of
 * free-text search, this scans recent commit messages (a reasonable proxy for
 * "what changed recently" claims) across the configured repos, and separately
 * fetches a specific file's content if the query names a path directly.
 */
export async function searchBitbucketServer(query: string, limit = 5): Promise<BitbucketMatch[]> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }

  const matches: BitbucketMatch[] = [];
  const filePath = extractFilePath(query);

  for (const { project, repo } of config.bitbucketServerRepos) {
    if (filePath) {
      try {
        const data = await apiGet(
          `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/raw/${filePath}`
        );
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        matches.push({ path: `${project}/${repo}/${filePath}`, snippet: text.slice(0, 1500) });
      } catch {
        // File may not exist in this repo — fine, just skip it.
      }
    }

    try {
      const commits = await apiGet(
        `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/commits?limit=50`
      );
      const queryWords = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      for (const commit of commits.values ?? []) {
        const message: string = commit.message ?? '';
        const messageLower = message.toLowerCase();
        if (queryWords.some((w) => messageLower.includes(w))) {
          matches.push({
            path: `${project}/${repo}@${commit.displayId}`,
            snippet: message.split('\n')[0].slice(0, 300),
          });
          if (matches.length >= limit) break;
        }
      }
    } catch (err: any) {
      console.error(`[bitbucket] commit search failed for ${project}/${repo}:`, err.message);
    }

    if (matches.length >= limit) break;
  }

  return matches.slice(0, limit);
}

type PrRef = Pick<BitbucketPullRequest, 'id' | 'projectKey' | 'repoSlug'>;

/** Every file path touched by a PR, via the /changes endpoint — used to stage review comments (a finding whose file isn't in this list can't be an inline/file-level comment). NOT yet confirmed live against a real Bitbucket Server instance (none configured in this dev environment) — verify the `path` shape (`path.toString`/`path.name`) against one real response before relying on this. */
export async function getPullRequestChangedPaths(pr: PrRef): Promise<string[]> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }
  const raw = await apiGetAllPages(
    `/rest/api/1.0/projects/${encodeURIComponent(pr.projectKey)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/changes?limit=500`,
    500
  );
  return raw.map((c: any) => (typeof c.path?.toString === 'string' ? c.path.toString : c.path?.name ?? '')).filter(Boolean);
}

export interface DiffAnchor {
  line: number;
  lineType: 'ADDED' | 'CONTEXT' | 'REMOVED';
  fileType: 'FROM' | 'TO';
}

/**
 * Flattens one file's diff hunks into anchorable (line, lineType, fileType)
 * triples — Bitbucket 400s if you anchor a comment to a line that isn't
 * actually part of the effective diff, so this is what lets
 * resolveFindingAnchor (prReviewComments.ts) tell an inline comment from a
 * file-level fallback. ADDED/CONTEXT lines anchor on the destination
 * (post-change, fileType 'TO') side; REMOVED lines only exist pre-change
 * (fileType 'FROM'). NOT yet confirmed live — same caveat as
 * getPullRequestChangedPaths above.
 */
export async function getPullRequestDiffAnchors(pr: PrRef, path: string): Promise<DiffAnchor[]> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }
  const raw = await apiGet(
    `/rest/api/1.0/projects/${encodeURIComponent(pr.projectKey)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/diff/${path}?contextLines=0`
  );
  const anchors: DiffAnchor[] = [];
  for (const diff of raw?.diffs ?? []) {
    for (const hunk of diff.hunks ?? []) {
      for (const segment of hunk.segments ?? []) {
        const lineType = segment.type as 'ADDED' | 'CONTEXT' | 'REMOVED';
        for (const line of segment.lines ?? []) {
          if (lineType === 'REMOVED') {
            anchors.push({ line: line.source, lineType, fileType: 'FROM' });
          } else {
            anchors.push({ line: line.destination, lineType, fileType: 'TO' });
          }
        }
      }
    }
  }
  return anchors;
}

export interface BitbucketCommentAnchor {
  path: string;
  srcPath?: string;
  line?: number;
  lineType?: 'ADDED' | 'CONTEXT' | 'REMOVED';
  fileType?: 'FROM' | 'TO';
  diffType?: 'EFFECTIVE';
}

export interface BitbucketCommentInput {
  text: string;
  anchor?: BitbucketCommentAnchor;
  /** Set to reply to an existing comment (used both for genuine threaded replies and for posting a retraction as a reply to the original). */
  parentId?: number;
}

export interface BitbucketCommentRef {
  id: number;
  version: number;
}

/** Real write — inline/file-level/general PR comment depending on whether `input.anchor` is set and whether it includes a `line`. `version` on the response is required for any later edit/delete of this same comment. */
export async function addPullRequestComment(pr: PrRef, input: BitbucketCommentInput): Promise<BitbucketCommentRef> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }
  const body: Record<string, unknown> = { text: input.text };
  if (input.anchor) {
    body.anchor = {
      path: input.anchor.path,
      diffType: input.anchor.diffType ?? 'EFFECTIVE',
      ...(input.anchor.srcPath ? { srcPath: input.anchor.srcPath } : {}),
      ...(input.anchor.line !== undefined ? { line: input.anchor.line, lineType: input.anchor.lineType, fileType: input.anchor.fileType } : {}),
    };
  }
  if (input.parentId !== undefined) body.parent = { id: input.parentId };
  const raw = await apiSend(
    `/rest/api/1.0/projects/${encodeURIComponent(pr.projectKey)}/repos/${encodeURIComponent(pr.repoSlug)}/pull-requests/${pr.id}/comments`,
    'POST',
    body
  );
  return { id: raw.id, version: raw.version };
}

export interface CreatePullRequestInput {
  projectKey: string;
  repoSlug: string;
  title: string;
  description: string;
  /** Short branch name (e.g. "feature/PROJ-1234-add-oauth-refresh") — the caller is responsible for confirming it's already pushed to origin; this call does not push anything itself. */
  fromBranch: string;
  toBranch: string;
  reviewerUsernames?: string[];
}

/** Real write — opens a PR via Bitbucket Server's PR-create endpoint. NOT yet confirmed live (no Bitbucket instance configured in this dev environment) — verify the request/response shape against one real repo before relying on this in production. */
export async function createPullRequest(input: CreatePullRequestInput): Promise<BitbucketPullRequest> {
  if (!isBitbucketConfigured()) {
    throw new Error('Bitbucket Server is not configured — see NOTES.md.');
  }
  const body = {
    title: input.title,
    description: input.description,
    state: 'OPEN',
    open: true,
    closed: false,
    fromRef: { id: `refs/heads/${input.fromBranch}`, repository: { slug: input.repoSlug, project: { key: input.projectKey } } },
    toRef: { id: `refs/heads/${input.toBranch}`, repository: { slug: input.repoSlug, project: { key: input.projectKey } } },
    locked: false,
    reviewers: (input.reviewerUsernames ?? []).map((name) => ({ user: { name } })),
  };
  const raw = await apiSend(`/rest/api/1.0/projects/${encodeURIComponent(input.projectKey)}/repos/${encodeURIComponent(input.repoSlug)}/pull-requests`, 'POST', body);
  return mapPullRequest(raw);
}


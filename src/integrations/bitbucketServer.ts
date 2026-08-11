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
  };
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

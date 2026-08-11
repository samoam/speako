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

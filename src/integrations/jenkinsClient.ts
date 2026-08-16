import { config } from '../config';

/**
 * Thin REST client, not MCP — deliberately, even though a `jenkins-acceo`
 * MCP server is available in this workspace. Reasons: (1) the MCP client's
 * shared tool-call timeout (src/mcp/mcpClient.ts) is tuned for short
 * fact-check lookups, too short for a console-log fetch on a slow build;
 * (2) console logs can be large — REST lets this fetch just the tail it
 * needs rather than round-tripping a whole log as a JSON-wrapped string;
 * (3) auth here is the same Basic-auth-over-REST shape as bitbucketServer.ts,
 * no OAuth/complex-auth reason to reach for MCP. The Jenkins instance itself
 * (https://automation.gtechna.net) and credentials are real/live-configured;
 * the response shapes below follow Jenkins' own long-stable, well-documented
 * REST API (core job/build tree, testReport, Pipeline Stage View's /wfapi) —
 * not independently confirmed live from this codebase the way Bitbucket
 * Server's less-documented diff-anchor shape was, so verify against one real
 * job/build here before depending on anything non-obvious.
 */

export function isJenkinsConfigured(): boolean {
  return !!(config.jenkinsUrl && config.jenkinsUser && config.jenkinsApiToken);
}

function authHeader(): string {
  const basic = Buffer.from(`${config.jenkinsUser}:${config.jenkinsApiToken}`).toString('base64');
  return `Basic ${basic}`;
}

const REQUEST_TIMEOUT_MS = 15_000;
const CONSOLE_TIMEOUT_MS = 30_000;

function requireConfigured(): void {
  if (!isJenkinsConfigured()) {
    throw new Error('Jenkins is not configured — see NOTES.md.');
  }
}

async function apiGet(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
  const res = await fetch(`${config.jenkinsUrl}${path}`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Jenkins request failed: ${res.status} ${res.statusText} — ${path}`);
  }
  return res.json();
}

/** Returns null for a 404 (build/job/report doesn't exist) rather than throwing — that's an expected, not exceptional, outcome for e.g. "no test report on this build." */
async function apiGetOrNull(path: string): Promise<any> {
  try {
    return await apiGet(path);
  } catch (err: any) {
    if (String(err?.message).includes(' 404 ')) return null;
    throw err;
  }
}

async function getCrumb(): Promise<{ field: string; value: string } | null> {
  try {
    const data = await apiGet('/crumbIssuer/api/json');
    return { field: data.crumbRequestField, value: data.crumb };
  } catch {
    return null; // CSRF protection may simply be disabled on this instance.
  }
}

/** POSTs a Jenkins action endpoint (build trigger) — form-encoded params in the query string, matching Jenkins' own convention, plus a CSRF crumb if this instance requires one. */
async function apiPostForm(path: string, params: Record<string, string> = {}): Promise<void> {
  const crumb = await getCrumb();
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${config.jenkinsUrl}${path}${query ? `?${query}` : ''}`, {
    method: 'POST',
    headers: { Authorization: authHeader(), ...(crumb ? { [crumb.field]: crumb.value } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Jenkins request failed: ${res.status} ${res.statusText} — ${path}`);
  }
}

/**
 * "FOLDER/multibranch" + an optional branch -> "/job/FOLDER/job/multibranch/job/<branch-encoded>".
 * encodeURIComponent turns a branch name's '/' into '%2F', which is exactly
 * how Jenkins multibranch pipeline jobs address a branch job (branch names
 * containing '/', e.g. "feature/PROJ-1-x", are themselves one path segment).
 */
export function jobPathFor(folderPath: string, branch?: string): string {
  const segments = folderPath
    .split('/')
    .filter(Boolean)
    .map((s) => `job/${encodeURIComponent(s)}`);
  const base = `/${segments.join('/')}`;
  return branch ? `${base}/job/${encodeURIComponent(branch)}` : base;
}

export interface JenkinsBuildStatus {
  jobPath: string;
  number: number;
  result: string | null;
  building: boolean;
  timestamp: number;
  durationMs: number;
  url: string;
  displayName: string;
}

function mapBuild(jobPath: string, raw: any): JenkinsBuildStatus {
  return {
    jobPath,
    number: raw.number,
    result: raw.result ?? null,
    building: !!raw.building,
    timestamp: raw.timestamp ?? 0,
    durationMs: raw.duration ?? 0,
    url: raw.url ?? '',
    displayName: raw.displayName ?? `#${raw.number}`,
  };
}

const BUILD_TREE = 'number,result,building,timestamp,duration,url,displayName';

export async function getLastBuild(jobPath: string): Promise<JenkinsBuildStatus | null> {
  requireConfigured();
  const raw = await apiGetOrNull(`${jobPath}/lastBuild/api/json?tree=${BUILD_TREE}`);
  return raw ? mapBuild(jobPath, raw) : null;
}

export async function getRecentBuilds(jobPath: string, limit = 10): Promise<JenkinsBuildStatus[]> {
  requireConfigured();
  const raw = await apiGet(`${jobPath}/api/json?tree=builds[${BUILD_TREE}]{0,${limit}}`);
  return (raw.builds ?? []).map((b: any) => mapBuild(jobPath, b));
}

/** Fetches the build's full console text and returns only the last `maxBytes` characters — bounded so a classification pass never has to hold a multi-megabyte log in memory/prompt. */
export async function getConsoleTail(jobPath: string, buildNumber: number, maxBytes = 60_000): Promise<string> {
  requireConfigured();
  const res = await fetch(`${config.jenkinsUrl}${jobPath}/${buildNumber}/consoleText`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(CONSOLE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Jenkins request failed: ${res.status} ${res.statusText} — console log for ${jobPath}#${buildNumber}`);
  }
  const text = await res.text();
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}

export interface JenkinsTestFailure {
  className: string;
  name: string;
  errorDetails: string | null;
  errorStackTrace: string | null;
  /** Jenkins' own "how many consecutive builds has this test been failing" counter — 1 means newly failing this build, a real signal for flaky-vs-regression classification. */
  age: number;
}

export interface JenkinsTestReport {
  total: number;
  failCount: number;
  skipCount: number;
  failures: JenkinsTestFailure[];
}

/** Null if this build has no test report at all (a build stage failed before tests ran, or the job doesn't publish one) — a normal outcome, not an error. */
export async function getTestReport(jobPath: string, buildNumber: number): Promise<JenkinsTestReport | null> {
  requireConfigured();
  const raw = await apiGetOrNull(
    `${jobPath}/${buildNumber}/testReport/api/json?tree=totalCount,failCount,skipCount,suites[cases[className,name,status,errorDetails,errorStackTrace,age]]`
  );
  if (!raw) return null;
  const failures: JenkinsTestFailure[] = [];
  for (const suite of raw.suites ?? []) {
    for (const c of suite.cases ?? []) {
      if (c.status === 'FAILED' || c.status === 'REGRESSION') {
        failures.push({ className: c.className, name: c.name, errorDetails: c.errorDetails ?? null, errorStackTrace: c.errorStackTrace ?? null, age: c.age ?? 0 });
      }
    }
  }
  return { total: raw.totalCount ?? 0, failCount: raw.failCount ?? 0, skipCount: raw.skipCount ?? 0, failures };
}

export interface JenkinsStage {
  name: string;
  status: string;
  durationMs: number;
}

/** Empty array (not an error) if the Pipeline Stage View plugin isn't installed or this isn't a pipeline job — the failure-classification heuristic degrades to "no stage information" rather than breaking. */
export async function getPipelineStages(jobPath: string, buildNumber: number): Promise<JenkinsStage[]> {
  requireConfigured();
  const raw = await apiGetOrNull(`${jobPath}/${buildNumber}/wfapi/describe`);
  if (!raw) return [];
  return (raw.stages ?? []).map((s: any) => ({ name: s.name, status: s.status, durationMs: s.durationMillis ?? 0 }));
}

export async function triggerBuild(jobPath: string, params: Record<string, string> = {}): Promise<void> {
  requireConfigured();
  const endpoint = Object.keys(params).length ? `${jobPath}/buildWithParameters` : `${jobPath}/build`;
  await apiPostForm(endpoint, params);
}

/** Jenkins indexes multibranch-pipeline branches lazily (a freshly-pushed branch may not have a job yet) — null means "not indexed yet," not a real error; callers should retry on a later poll rather than surfacing this as a failure. */
export async function findBranchJob(folderPath: string, branch: string): Promise<string | null> {
  requireConfigured();
  const path = jobPathFor(folderPath, branch);
  const raw = await apiGetOrNull(`${path}/api/json?tree=name`);
  return raw ? path : null;
}

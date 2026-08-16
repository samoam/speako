import { db } from './db';

export type JenkinsBuildResult = 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED' | null;
export type FailureCategory = 'compile_error' | 'lint_error' | 'test_regression' | 'flaky_test' | 'infra_failure' | 'unknown';

export interface JenkinsBuildRow {
  id: number;
  devCycleId: number | null;
  jobPath: string;
  branchName: string | null;
  buildNumber: number;
  result: JenkinsBuildResult;
  building: boolean;
  url: string | null;
  startedAt: string | null;
  classification: FailureCategory | null;
  classificationJson: any;
  logExcerpt: string | null;
  notified: boolean;
  createdAt: string;
}

function safeJsonParse(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapRow(row: any): JenkinsBuildRow {
  return {
    id: row.id,
    devCycleId: row.dev_cycle_id,
    jobPath: row.job_path,
    branchName: row.branch_name,
    buildNumber: row.build_number,
    result: row.result,
    building: !!row.building,
    url: row.url,
    startedAt: row.started_at,
    classification: row.classification,
    classificationJson: safeJsonParse(row.classification_json),
    logExcerpt: row.log_excerpt,
    notified: !!row.notified,
    createdAt: row.created_at,
  };
}

/** Upserts on (job_path, build_number) — re-polling an already-seen build (e.g. it went from building to a final result) updates the same row rather than duplicating it. */
export function upsertJenkinsBuild(params: {
  devCycleId?: number | null;
  jobPath: string;
  branchName?: string | null;
  buildNumber: number;
  result: JenkinsBuildResult;
  building: boolean;
  url?: string | null;
  startedAt?: string | null;
}): JenkinsBuildRow {
  db.prepare(
    `INSERT INTO jenkins_builds (dev_cycle_id, job_path, branch_name, build_number, result, building, url, started_at)
     VALUES (@devCycleId, @jobPath, @branchName, @buildNumber, @result, @building, @url, @startedAt)
     ON CONFLICT(job_path, build_number) DO UPDATE SET
       dev_cycle_id = excluded.dev_cycle_id,
       branch_name = excluded.branch_name,
       result = excluded.result,
       building = excluded.building,
       url = excluded.url,
       started_at = excluded.started_at`
  ).run({
    devCycleId: params.devCycleId ?? null,
    jobPath: params.jobPath,
    branchName: params.branchName ?? null,
    buildNumber: params.buildNumber,
    result: params.result,
    building: params.building ? 1 : 0,
    url: params.url ?? null,
    startedAt: params.startedAt ?? null,
  });
  return getJenkinsBuildByJobAndNumber(params.jobPath, params.buildNumber)!;
}

export function getJenkinsBuild(id: number): JenkinsBuildRow | undefined {
  const row = db.prepare('SELECT * FROM jenkins_builds WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

export function getJenkinsBuildByJobAndNumber(jobPath: string, buildNumber: number): JenkinsBuildRow | undefined {
  const row = db.prepare('SELECT * FROM jenkins_builds WHERE job_path = ? AND build_number = ?').get(jobPath, buildNumber) as any;
  return row ? mapRow(row) : undefined;
}

export function getLatestBuildForJob(jobPath: string): JenkinsBuildRow | undefined {
  const row = db.prepare('SELECT * FROM jenkins_builds WHERE job_path = ? ORDER BY build_number DESC LIMIT 1').get(jobPath) as any;
  return row ? mapRow(row) : undefined;
}

/** Used by the flaky-vs-real-regression heuristic — a test that passed in a recent build on this same job is more likely flaky than a genuine new regression. */
export function getRecentBuildsForJob(jobPath: string, limit: number): JenkinsBuildRow[] {
  const rows = db.prepare('SELECT * FROM jenkins_builds WHERE job_path = ? ORDER BY build_number DESC LIMIT ?').all(jobPath, limit) as any[];
  return rows.map(mapRow);
}

export function setBuildClassification(id: number, params: { classification: FailureCategory; classificationJson: unknown; logExcerpt: string }): void {
  db.prepare('UPDATE jenkins_builds SET classification = ?, classification_json = ?, log_excerpt = ? WHERE id = ?').run(
    params.classification,
    JSON.stringify(params.classificationJson),
    params.logExcerpt,
    id
  );
}

export function markBuildNotified(id: number): void {
  db.prepare('UPDATE jenkins_builds SET notified = 1 WHERE id = ?').run(id);
}

export function getUnnotifiedFailures(): JenkinsBuildRow[] {
  const rows = db
    .prepare("SELECT * FROM jenkins_builds WHERE notified = 0 AND result IN ('FAILURE', 'UNSTABLE')")
    .all() as any[];
  return rows.map(mapRow);
}

/** The LATEST build per job_path, filtered to those currently red — this is "what's failing right now," distinct from getUnnotifiedFailures (a live-broadcast dedup flag) which a task board can't use since it's cleared the moment a failure is first observed. Used by taskSync.ts's syncJenkins() to surface red builds on My Plate. */
export function getCurrentFailingBuilds(): JenkinsBuildRow[] {
  const rows = db
    .prepare(
      `SELECT jb.* FROM jenkins_builds jb
       INNER JOIN (
         SELECT job_path, MAX(build_number) AS max_build_number
         FROM jenkins_builds
         GROUP BY job_path
       ) latest ON jb.job_path = latest.job_path AND jb.build_number = latest.max_build_number
       WHERE jb.result IN ('FAILURE', 'UNSTABLE')`
    )
    .all() as any[];
  return rows.map(mapRow);
}

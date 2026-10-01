import { db } from './db';

export type JenkinsBuildRequestStatus = 'queued' | 'started' | 'finished' | 'cancelled' | 'lost';

export interface JenkinsBuildRequest {
  id: number;
  devCycleId: number | null;
  jobPath: string;
  jobFullName: string;
  branchName: string;
  queueId: number;
  buildNumber: number | null;
  status: JenkinsBuildRequestStatus;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: any): JenkinsBuildRequest {
  return {
    id: row.id,
    devCycleId: row.dev_cycle_id,
    jobPath: row.job_path,
    jobFullName: row.job_full_name,
    branchName: row.branch_name,
    queueId: row.queue_id,
    buildNumber: row.build_number,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createJenkinsBuildRequest(params: { devCycleId: number | null; jobPath: string; jobFullName: string; branchName: string; queueId: number }): JenkinsBuildRequest {
  const result = db
    .prepare('INSERT INTO jenkins_build_requests (dev_cycle_id, job_path, job_full_name, branch_name, queue_id) VALUES (@devCycleId, @jobPath, @jobFullName, @branchName, @queueId)')
    .run(params);
  return getJenkinsBuildRequest(result.lastInsertRowid as number)!;
}

export function getJenkinsBuildRequest(id: number): JenkinsBuildRequest | undefined {
  const row = db.prepare('SELECT * FROM jenkins_build_requests WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : undefined;
}

/** Everything the monitor still has to follow: waiting in Jenkins' queue, or building. */
export function getOpenJenkinsBuildRequests(): JenkinsBuildRequest[] {
  const rows = db.prepare("SELECT * FROM jenkins_build_requests WHERE status IN ('queued', 'started') ORDER BY id").all() as any[];
  return rows.map(mapRow);
}

export function getJenkinsBuildRequestsForCycle(devCycleId: number, limit = 10): JenkinsBuildRequest[] {
  const rows = db.prepare('SELECT * FROM jenkins_build_requests WHERE dev_cycle_id = ? ORDER BY id DESC LIMIT ?').all(devCycleId, limit) as any[];
  return rows.map(mapRow);
}

export function markJenkinsBuildRequestStarted(id: number, buildNumber: number): void {
  db.prepare("UPDATE jenkins_build_requests SET status = 'started', build_number = ?, updated_at = datetime('now') WHERE id = ?").run(buildNumber, id);
}

export function setJenkinsBuildRequestStatus(id: number, status: JenkinsBuildRequestStatus): void {
  db.prepare("UPDATE jenkins_build_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

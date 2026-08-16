import { config } from '../config';
import { getActiveDevCycles, setDevCycleJenkinsJob } from '../storage/devCycleRepository';
import { upsertJenkinsBuild, getLatestBuildForJob, setBuildClassification, markBuildNotified, JenkinsBuildResult } from '../storage/jenkinsBuildRepository';
import { isJenkinsConfigured, findBranchJob, getLastBuild, getConsoleTail, getTestReport, getPipelineStages, getRecentBuilds } from '../integrations/jenkinsClient';
import { extractSignals, classifyBuildFailure } from './buildFailureClassification';
import { extractTicketKeyFromBranch } from './branchNaming';

type Broadcast = (event: Record<string, unknown>) => void;

/**
 * One poll tick — targets active dev-cycle branches only for now (a
 * reviewed-PR-branch source, matching branches from Bitbucket's REVIEWER/
 * AUTHOR dashboards, is a natural extension once that consumer exists;
 * nothing here prevents adding `dev_cycle_id: null` rows for those the same
 * way). Resolves each cycle's Jenkins job path lazily and caches it on the
 * cycle once found — Jenkins indexes multibranch-pipeline branches lazily,
 * so "not found yet" just means try again next poll, not an error.
 */
export async function pollJenkinsBuilds(broadcast: Broadcast): Promise<{ checked: number; newFailures: number }> {
  if (!isJenkinsConfigured()) return { checked: 0, newFailures: 0 };

  let checked = 0;
  let newFailures = 0;

  const cycles = getActiveDevCycles().filter((c) => c.branchName);
  for (const cycle of cycles) {
    try {
      let jobPath = cycle.jenkinsJobPath;
      if (!jobPath) {
        const folder = config.jenkinsJobFolders.find((f) => f.name === cycle.repoName)?.folderPath;
        if (!folder) continue; // no Jenkins folder mapping configured for this repo
        const found = await findBranchJob(folder, cycle.branchName!);
        if (!found) continue; // not indexed by Jenkins yet — retry next poll
        jobPath = found;
        setDevCycleJenkinsJob(cycle.id, jobPath);
      }
      checked++;
      if (await checkOneJob(jobPath, cycle.branchName!, cycle.id, broadcast)) newFailures++;
    } catch (err: any) {
      console.error(`[jenkins-monitor] failed to poll dev cycle ${cycle.id}:`, err.message);
    }
  }

  return { checked, newFailures };
}

/** Returns true if this tick found (and classified) a fresh failure. */
async function checkOneJob(jobPath: string, branch: string, devCycleId: number, broadcast: Broadcast): Promise<boolean> {
  const last = await getLastBuild(jobPath);
  if (!last) return false;

  // The LATEST build Speako had on record for this job BEFORE this poll's
  // upsert — deliberately keyed on jobPath alone, not (jobPath, buildNumber):
  // a recovery is "the latest build went from red to green," which by
  // definition compares against whatever build was latest a moment ago, not
  // against whatever happens to share today's build number (a fresh build
  // number has never been seen before, so looking it up by number would
  // always return nothing and recovery could never fire).
  const previousLatest = getLatestBuildForJob(jobPath);
  if (previousLatest && previousLatest.buildNumber === last.number && previousLatest.result === last.result && previousLatest.building === last.building) {
    return false; // already recorded, nothing changed since the last poll
  }

  const row = upsertJenkinsBuild({
    devCycleId,
    jobPath,
    branchName: branch,
    buildNumber: last.number,
    result: last.result as JenkinsBuildResult,
    building: last.building,
    url: last.url,
    startedAt: last.timestamp ? new Date(last.timestamp).toISOString() : null,
  });
  broadcast({ type: 'jenkins-build-updated', devCycleId, jobPath, buildNumber: last.number, result: last.result, building: last.building, branch });

  if (last.building) return false; // still running — classify once it settles

  if (last.result === 'SUCCESS') {
    if (previousLatest?.result && previousLatest.result !== 'SUCCESS') {
      broadcast({ type: 'jenkins-build-recovered', devCycleId, jobPath, buildNumber: last.number, branch });
    }
    return false;
  }

  if (last.result === 'FAILURE' || last.result === 'UNSTABLE') {
    const [log, report, stages, recentBuilds] = await Promise.all([
      getConsoleTail(jobPath, last.number),
      getTestReport(jobPath, last.number),
      getPipelineStages(jobPath, last.number),
      getRecentBuilds(jobPath, 6),
    ]);
    const recentReports = (
      await Promise.all(recentBuilds.filter((b) => b.number !== last.number).map((b) => getTestReport(jobPath, b.number)))
    ).filter((r): r is NonNullable<typeof r> => !!r);

    const signals = extractSignals(log, report, stages, recentReports);
    const ticketKey = extractTicketKeyFromBranch(branch);
    const analysis = await classifyBuildFailure({ log, signals, stages, report, branch, ticketKey });

    setBuildClassification(row.id, { classification: analysis.category, classificationJson: analysis, logExcerpt: log.slice(-4000) });
    broadcast({ type: 'jenkins-build-failed', devCycleId, jobPath, buildNumber: last.number, branch, classification: analysis.category, summary: analysis.summary });
    markBuildNotified(row.id);
    return true;
  }

  return false; // ABORTED or anything else — recorded above, nothing further to classify
}

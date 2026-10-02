import { config } from '../config';
import { getActiveDevCycles, setDevCycleJenkinsJob } from '../storage/devCycleRepository';
import {
  upsertJenkinsBuild,
  getLatestBuildForJob,
  getJenkinsBuildByJobAndNumber,
  getRecentBuildsForJobBranch,
  setBuildClassification,
  markBuildNotified,
  JenkinsBuildResult,
  JenkinsBuildRow,
} from '../storage/jenkinsBuildRepository';
import { getOpenJenkinsBuildRequests, markJenkinsBuildRequestStarted, setJenkinsBuildRequestStatus } from '../storage/jenkinsBuildRequestRepository';
import { isJenkinsConfigured, findBranchJob, getLastBuild, getConsoleTail, getTestReport, getPipelineStages, getRecentBuilds, findBuildNumberByQueueId, JenkinsBuildStatus } from '../integrations/jenkinsClient';
import { getQueueState, getBuildByNumber } from '../integrations/jenkinsMcp';
import { extractSignals, classifyBuildFailure } from './buildFailureClassification';
import { extractTicketKeyFromBranch } from './branchNaming';

type Broadcast = (event: Record<string, unknown>) => void;

/**
 * One poll tick, two sources: (1) dev cycles whose repo maps to a per-branch
 * job folder (config.jenkinsJobFolders — multibranch layouts), resolved
 * lazily and cached on the cycle; (2) builds Speako itself triggered on the
 * shared build-and-test job (jenkins_build_requests), each followed by its
 * own build number since that job's latest build may be another branch's.
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

  const fromRequests = await pollBuildRequests(broadcast);
  return { checked: checked + fromRequests.checked, newFailures: newFailures + fromRequests.newFailures };
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
  return recordBuild({
    jobPath,
    build: last,
    branch,
    devCycleId,
    previousLatest,
    comparisonBuildNumbers: async () => (await getRecentBuilds(jobPath, 6)).map((b) => b.number),
  }, broadcast);
}

/**
 * Follows each open request on the shared job: queue item -> build number ->
 * that specific build until it settles. Errors are per-request so one bad
 * request never stalls the rest.
 */
async function pollBuildRequests(broadcast: Broadcast): Promise<{ checked: number; newFailures: number }> {
  let checked = 0;
  let newFailures = 0;
  for (const request of getOpenJenkinsBuildRequests()) {
    try {
      let buildNumber = request.buildNumber;
      if (request.status === 'queued' || buildNumber == null) {
        const queue = await getQueueState(request.queueId);
        if (queue.state === 'waiting') continue;
        if (queue.state === 'started') {
          buildNumber = queue.buildNumber;
        } else {
          // The queue item is gone — expired after the build started (the
          // common case when the first poll comes late), or cancelled. The
          // build itself still remembers its queue id, so look there first.
          const found = queue.state === 'gone' ? await findBuildNumberByQueueId(request.jobPath, request.queueId) : null;
          if (found == null) {
            setJenkinsBuildRequestStatus(request.id, queue.state === 'cancelled' ? 'cancelled' : 'lost');
            broadcast({ type: 'jenkins-build-request-updated', devCycleId: request.devCycleId, requestId: request.id, status: queue.state === 'cancelled' ? 'cancelled' : 'lost' });
            continue;
          }
          buildNumber = found;
        }
        markJenkinsBuildRequestStarted(request.id, buildNumber);
      }

      const build = await getBuildByNumber(request.jobFullName, buildNumber);
      if (!build) continue; // Jenkins hasn't materialized it yet — next poll
      checked++;

      const already = getJenkinsBuildByJobAndNumber(request.jobPath, buildNumber);
      if (!already || already.result !== build.result || already.building !== build.building) {
        // Same branch only: on the shared job the previous build and the
        // flaky-comparison builds must be this branch's, not whichever branch
        // happened to build last.
        const branchHistory = getRecentBuildsForJobBranch(request.jobPath, request.branchName, 7).filter((b) => b.buildNumber !== buildNumber);
        const failed = await recordBuild({
          jobPath: request.jobPath,
          build,
          branch: request.branchName,
          devCycleId: request.devCycleId,
          previousLatest: branchHistory[0],
          comparisonBuildNumbers: async () => branchHistory.slice(0, 5).map((b) => b.buildNumber),
        }, broadcast);
        if (failed) newFailures++;
      }
      if (!build.building) setJenkinsBuildRequestStatus(request.id, 'finished');
    } catch (err: any) {
      console.error(`[jenkins-monitor] failed to follow build request ${request.id}:`, err.message);
    }
  }
  return { checked, newFailures };
}

/** Upserts one observed build, broadcasts it, and classifies it if it failed. Returns true for a freshly classified failure. */
async function recordBuild(
  params: {
    jobPath: string;
    build: JenkinsBuildStatus;
    branch: string;
    devCycleId: number | null;
    previousLatest: JenkinsBuildRow | undefined;
    comparisonBuildNumbers: () => Promise<number[]>;
  },
  broadcast: Broadcast
): Promise<boolean> {
  const { jobPath, build: last, branch, devCycleId, previousLatest } = params;
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
    const [log, report, stages, comparisonNumbers] = await Promise.all([
      getConsoleTail(jobPath, last.number),
      getTestReport(jobPath, last.number),
      getPipelineStages(jobPath, last.number),
      params.comparisonBuildNumbers(),
    ]);
    const recentReports = (
      await Promise.all(comparisonNumbers.filter((n) => n !== last.number).map((n) => getTestReport(jobPath, n)))
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

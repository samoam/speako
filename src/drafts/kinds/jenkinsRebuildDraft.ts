import { config } from '../../config';
import { DevCycle, getDevCycle } from '../../storage/devCycleRepository';
import { triggerBuild, jobPathFor } from '../../integrations/jenkinsClient';
import { triggerJenkinsBuild } from '../../integrations/jenkinsMcp';
import { createJenkinsBuildRequest } from '../../storage/jenkinsBuildRequestRepository';
import { DraftHandler } from '../types';

export interface JenkinsRebuildContent {
  jobPath: string;
  branchName: string | null;
  /** Set when this runs on the shared build-and-test job: its full name (MCP addresses jobs by name) and the parameter carrying the branch. */
  testJob?: { fullName: string; branchParam: string };
}

/**
 * Builds and tests a dev cycle's branch — its own gate, separate from a fix
 * (per the blueprint, a Jenkins re-trigger is "configurable... can be auto
 * once the fix itself was approved," but never silently automatic here — an
 * explicit approval every time, matching every other write in this app).
 * Two shapes: a per-branch job already mapped on the cycle (multibranch
 * layouts) is re-triggered as-is over REST; otherwise the shared
 * config.jenkinsTestJob is triggered over MCP with the branch as a build
 * parameter, and the returned queue item is recorded so jenkinsMonitor.ts can
 * follow that exact build.
 */
export const jenkinsRebuildDraft: DraftHandler<DevCycle> = {
  kind: 'jenkins_rebuild',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'rebuild', label: 'Run build & tests' }],
  redoStrategy: 'fresh',
  supportsRefine: false,
  loadSubject: (subjectId) => getDevCycle(Number(subjectId)),
  async generate(input) {
    const cycle = input.subject;
    if (cycle.jenkinsJobPath) {
      return { mode: 'draft', content: { jobPath: cycle.jenkinsJobPath, branchName: cycle.branchName } };
    }
    if (!config.jenkinsTestJob) {
      throw new Error('No Jenkins job for this branch — set the "Build & test job" in Settings > Jenkins.');
    }
    if (!cycle.branchName) throw new Error('This dev cycle has no branch yet.');
    const content: JenkinsRebuildContent = {
      jobPath: jobPathFor(config.jenkinsTestJob),
      branchName: cycle.branchName,
      testJob: { fullName: config.jenkinsTestJob, branchParam: config.jenkinsTestBranchParam },
    };
    return { mode: 'draft', content };
  },
  async execute(_gateKey, ctx) {
    const cycle = ctx.subject;
    const content = ctx.content as JenkinsRebuildContent;
    if (content.testJob) {
      if (!content.branchName) throw new Error('This dev cycle has no branch yet.');
      const queueId = await triggerJenkinsBuild(content.testJob.fullName, { [content.testJob.branchParam]: content.branchName });
      const request = createJenkinsBuildRequest({
        devCycleId: cycle.id,
        jobPath: content.jobPath,
        jobFullName: content.testJob.fullName,
        branchName: content.branchName,
        queueId,
      });
      return { jobPath: content.jobPath, queueId, requestId: request.id, triggeredAt: new Date().toISOString() };
    }
    if (!cycle.jenkinsJobPath) throw new Error('This dev cycle has no Jenkins job mapped yet.');
    await triggerBuild(cycle.jenkinsJobPath);
    return { jobPath: cycle.jenkinsJobPath, triggeredAt: new Date().toISOString() };
  },
  legacyBroadcast(draft) {
    return [{ type: 'dev-cycle-updated', devCycleId: Number(draft.subjectId) }];
  },
};

import { DevCycle, getDevCycle } from '../../storage/devCycleRepository';
import { triggerBuild } from '../../integrations/jenkinsClient';
import { DraftHandler } from '../types';

export interface JenkinsRebuildContent {
  jobPath: string;
  branchName: string | null;
}

/**
 * Re-triggers the build for a dev cycle's Jenkins job — its own gate,
 * separate from a fix (per the blueprint, a Jenkins re-trigger is
 * "configurable... can be auto once the fix itself was approved," but never
 * silently automatic here — an explicit approval every time, matching every
 * other write in this app).
 */
export const jenkinsRebuildDraft: DraftHandler<DevCycle> = {
  kind: 'jenkins_rebuild',
  subjectKind: 'dev_cycle',
  gates: [{ key: 'rebuild', label: 'Trigger rebuild' }],
  redoStrategy: 'fresh',
  supportsRefine: false,
  loadSubject: (subjectId) => getDevCycle(Number(subjectId)),
  async generate(input) {
    const cycle = input.subject;
    if (!cycle.jenkinsJobPath) throw new Error('This dev cycle has no Jenkins job mapped yet.');
    return { mode: 'draft', content: { jobPath: cycle.jenkinsJobPath, branchName: cycle.branchName } };
  },
  async execute(_gateKey, ctx) {
    const cycle = ctx.subject;
    if (!cycle.jenkinsJobPath) throw new Error('This dev cycle has no Jenkins job mapped yet.');
    await triggerBuild(cycle.jenkinsJobPath);
    return { jobPath: cycle.jenkinsJobPath, triggeredAt: new Date().toISOString() };
  },
  legacyBroadcast(draft) {
    return [{ type: 'dev-cycle-updated', devCycleId: Number(draft.subjectId) }];
  },
};

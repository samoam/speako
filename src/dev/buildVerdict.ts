import { JenkinsTestReport } from '../integrations/jenkinsClient';

export interface BuildVerdict {
  pass: boolean;
  /** Tests failing in this build that were not failing before it — what the branch broke. */
  newFailures: string[];
  /** Tests failing in this build that were already failing (Jenkins' own `age` > 1, or seen in a recent build's report). */
  preexistingFailures: string[];
  reason: string;
}

/**
 * Whether an UNSTABLE build should count as green for a dev cycle. The
 * shared integration job's baseline is itself UNSTABLE (confirmed live
 * 2026-10-01: master built #167 with the same 2 failures as #166), so
 * "no failing tests" would fail every cycle on that job. A failure is
 * pre-existing when Jenkins' per-test `age` says it was already failing in
 * the previous build, or when the same test failed in any of the recent
 * builds' reports (any branch — on one shared job that's the only history
 * there is). Only failures that are new to this build fail the verdict.
 */
export function assessUnstableBuild(report: JenkinsTestReport | null, recentReports: JenkinsTestReport[]): BuildVerdict {
  if (!report) return { pass: false, newFailures: [], preexistingFailures: [], reason: 'unstable with no test report to compare against' };
  const recentlyFailed = new Set<string>();
  for (const recent of recentReports) for (const f of recent.failures) recentlyFailed.add(`${f.className}.${f.name}`);
  const newFailures: string[] = [];
  const preexistingFailures: string[] = [];
  for (const f of report.failures) {
    const name = `${f.className}.${f.name}`;
    if (f.age > 1 || recentlyFailed.has(name)) preexistingFailures.push(name);
    else newFailures.push(name);
  }
  if (newFailures.length) {
    return { pass: false, newFailures, preexistingFailures, reason: `${newFailures.length} new test failure(s): ${newFailures.join(', ')}` };
  }
  return { pass: true, newFailures, preexistingFailures, reason: `${preexistingFailures.length} pre-existing failure(s), none new` };
}

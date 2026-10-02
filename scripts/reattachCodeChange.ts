/**
 * Re-attaches Speako to a background change agent whose poll was lost
 * (a Speako restart, or the poll giving up while the agent kept working —
 * seen live on ETICK-10173 after the 20-minute limit): the request goes
 * back to 'running', the poll is resumed with the full budget, and for a
 * dev-cycle implementation the implementation row is recorded so a retry of
 * the run reuses it instead of starting the agent over.
 *
 *   npx ts-node scripts/reattachCodeChange.ts <requestId>   (config.ts loads .env itself)
 */
import { db } from '../src/storage/db';
import { getCodeChangeRequest } from '../src/storage/codeChangeRequestRepository';
import { pollCodeChangeRequest } from '../src/integrations/codeChangePoller';
import { getDevCycle } from '../src/storage/devCycleRepository';
import { createDevCycleImplementation, markDevCycleImplementationReady, markDevCycleImplementationFailed, getDevCycleImplementationsForCycle } from '../src/storage/devCycleImplementationRepository';

async function main(): Promise<void> {
  const requestId = Number(process.argv[2]);
  const request = getCodeChangeRequest(requestId);
  if (!request) throw new Error(`No code change request ${requestId}.`);
  console.log(`request ${requestId}: ${request.status} (agent ${request.cliSessionId}, origin ${request.origin}, cycle ${request.devCycleId})`);
  db.prepare("UPDATE code_change_requests SET status = 'running', error = NULL, resolved_at = NULL WHERE id = ?").run(requestId);
  await pollCodeChangeRequest(requestId, (e) => console.log('event', JSON.stringify(e)), { maxWaitMs: 90 * 60 * 1000 });
  const finished = getCodeChangeRequest(requestId)!;
  console.log(`request ${requestId}: ${finished.status}${finished.error ? ` — ${finished.error}` : ''}; diff ${finished.diff?.length ?? 0} chars`);

  if (finished.origin === 'dev_cycle_implement' && finished.devCycleId) {
    const cycle = getDevCycle(finished.devCycleId)!;
    const existing = getDevCycleImplementationsForCycle(cycle.id, cycle.round).find((i) => i.codeChangeRequestId === requestId);
    const row = existing ?? createDevCycleImplementation({ devCycleId: cycle.id, round: cycle.round, variant: 'claude', worktreePath: cycle.worktreePath!, codeChangeRequestId: requestId, cliSessionId: finished.cliSessionId });
    if (finished.status === 'ready') markDevCycleImplementationReady(row.id, finished.diff ?? '');
    else markDevCycleImplementationFailed(row.id, finished.error ?? 'failed');
    console.log(`implementation row ${row.id} (round ${cycle.round}): ${finished.status}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

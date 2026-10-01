import {
  Run,
  RunStep,
  createRun,
  getRun,
  getRunsByStatus,
  tryTransitionRun,
  setRunState,
  setRunStep,
  setRunCurrentStep,
  appendRunEvent,
  hasRunEvent,
  failInterruptedRuns,
} from '../storage/runRepository';
import { RunDefinition, StepDefinition, StepEntry, StepContext, RunOutcome, RunBroadcastEvent } from './types';

/**
 * The one place background pipelines run. A run is a row in
 * orchestration_runs plus a kind-specific step list (see types.ts); this
 * module queues runs, executes their steps in order (or in parallel for a
 * grouped entry) under a concurrency cap, pauses at approval steps, and
 * marks whatever a restart interrupted as failed so the UI can offer a
 * retry. Deliberately not a replay engine: a step is a CLI agent run that
 * can't be resumed mid-flight, so "durable" here means the run's status,
 * steps, state and log survive a restart — not that a half-finished step
 * picks up where it left off.
 */

/** Two heavy agent runs (each spawning a Claude Code + Antigravity process) is what the dev machine comfortably sustains — seen live that more than that starved everything else. */
const MAX_CONCURRENT_RUNS = 2;

const definitions = new Map<string, RunDefinition<any>>();
/** Runs this process is executing right now, with the controller that cancelRun() aborts. */
const active = new Map<number, AbortController>();
let broadcast: (event: RunBroadcastEvent) => void = () => {};

export function registerRunKind<S>(definition: RunDefinition<S>): void {
  definitions.set(definition.kind, definition);
}

export function setRunBroadcast(fn: (event: RunBroadcastEvent) => void): void {
  broadcast = fn;
}

/** True while this process is executing the run — a 'running' row without this is an orphan from a previous process. */
export function isRunActive(runId: number): boolean {
  return active.has(runId);
}

function flattenSteps<S>(entries: StepEntry<S>[]): StepDefinition<S>[] {
  return entries.flatMap((e) => (Array.isArray(e) ? e : [e]));
}

/** Creates the run (status 'queued', every step 'pending') and starts it as soon as a worker slot is free. */
export function startRun<S>(params: { kind: string; subjectKind: string; subjectId: string; state: S }): Run<S> {
  const definition = definitions.get(params.kind);
  if (!definition) throw new Error(`Unknown run kind "${params.kind}".`);
  const steps: RunStep[] = flattenSteps(definition.steps(params.state)).map((s) => ({ key: s.key, label: s.label, status: 'pending', detail: null }));
  const run = createRun({ ...params, steps });
  broadcast({ type: 'run-status', run });
  pump();
  return run;
}

/** Resumes a run parked at waiting_approval; the approval is recorded as a run_event so it survives a restart. Returns false if the run wasn't waiting. */
export function approveRun(runId: number): boolean {
  const run = getRun(runId);
  if (!run || run.status !== 'waiting_approval' || !run.currentStep) return false;
  appendRunEvent(runId, 'approval', run.currentStep, 'Approved.');
  if (!tryTransitionRun(runId, ['waiting_approval'], 'queued')) return false;
  broadcast({ type: 'run-status', run: getRun(runId)! });
  pump();
  return true;
}

/** Cancels a queued/waiting run immediately, or asks a running one to stop after its current step settles. Returns false if the run was already finished. */
export async function cancelRun(runId: number): Promise<boolean> {
  const controller = active.get(runId);
  if (controller) {
    controller.abort();
    return tryTransitionRun(runId, ['running'], 'cancelled', 'Cancelled.');
  }
  if (!tryTransitionRun(runId, ['queued', 'waiting_approval'], 'cancelled', 'Cancelled.')) return false;
  await finish(runId, 'cancelled', 'Cancelled.');
  return true;
}

/** Fails runs left 'running' by the previous process (running their finalize for cleanup), then restarts anything still queued. */
export async function reconcileRunsOnStartup(): Promise<number> {
  const interrupted = getRunsByStatus(['running']);
  const error = 'Interrupted — Speako restarted while this was running.';
  failInterruptedRuns(error);
  for (const run of interrupted) await finish(run.id, 'failed', error);
  pump();
  return interrupted.length;
}

function pump(): void {
  if (active.size >= MAX_CONCURRENT_RUNS) return;
  for (const run of getRunsByStatus(['queued'])) {
    if (active.size >= MAX_CONCURRENT_RUNS) return;
    if (active.has(run.id)) continue;
    const controller = new AbortController();
    active.set(run.id, controller);
    execute(run.id, controller).finally(() => {
      active.delete(run.id);
      pump();
    });
  }
}

/** Runs finalize and broadcasts the terminal status. Idempotent per terminal write (callers only reach this after a successful transition). */
async function finish(runId: number, outcome: RunOutcome, error: string | null): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const definition = definitions.get(run.kind);
  try {
    await definition?.finalize?.(run, outcome, error);
  } catch (err: any) {
    console.error(`[runs] finalize failed for run ${runId} (${run.kind}):`, err.message);
  }
  broadcast({ type: 'run-status', run: getRun(runId)! });
}

/** Rejects with "<label> timed out after Ns" if `promise` hasn't settled by then — the promise itself keeps running, only the wait is bounded. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function execute(runId: number, controller: AbortController): Promise<void> {
  if (!tryTransitionRun(runId, ['queued'], 'running')) return;
  const run = getRun(runId)!;
  const definition = definitions.get(run.kind);
  if (!definition) {
    tryTransitionRun(runId, ['running'], 'failed', `Unknown run kind "${run.kind}".`);
    await finish(runId, 'failed', `Unknown run kind "${run.kind}".`);
    return;
  }
  broadcast({ type: 'run-status', run });
  const state = run.state;
  const meta = { runId, kind: run.kind, subjectKind: run.subjectKind, subjectId: run.subjectId };
  const log = (message: string) => {
    appendRunEvent(runId, 'log', null, message);
    broadcast({ type: 'run-log', ...meta, message });
  };
  const step = (key: string, status: RunStep['status'], detail: string | null = null) => {
    setRunStep(runId, key, status, detail);
    const current = getRun(runId)?.steps.find((s) => s.key === key);
    if (current) broadcast({ type: 'run-step', ...meta, step: current });
  };

  const runStep = async (def: StepDefinition<any>): Promise<Error | null> => {
    step(def.key, 'running');
    const ctx: StepContext<any> = {
      runId,
      state,
      log,
      detail: (message) => step(def.key, 'running', message),
      signal: controller.signal,
    };
    try {
      const promise = def.run(ctx);
      const detail = def.timeoutMs ? await withTimeout(promise, def.timeoutMs, def.label) : await promise;
      step(def.key, 'done', typeof detail === 'string' ? detail : null);
      return null;
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err));
      step(def.key, 'failed', error.message);
      log(def.optional ? `${def.label} failed — continuing without it: ${error.message}` : `${def.label} failed: ${error.message}`);
      return def.optional ? null : error;
    }
  };

  try {
    const stepStatus = (key: string) => getRun(runId)!.steps.find((s) => s.key === key)!.status;
    for (const entry of definition.steps(state)) {
      if (controller.signal.aborted) break;
      const defs = Array.isArray(entry) ? entry : [entry];
      // Already-settled steps are skipped so a run resumed after an approval
      // (or re-queued by approveRun) continues from where it paused.
      const pending = defs.filter((d) => stepStatus(d.key) === 'pending');
      if (!pending.length) continue;
      const gate = pending.find((d) => d.approval);
      if (gate && !hasRunEvent(runId, 'approval', gate.key)) {
        setRunStep(runId, gate.key, 'pending', 'Waiting for your approval.');
        setRunCurrentStep(runId, gate.key);
        tryTransitionRun(runId, ['running'], 'waiting_approval');
        broadcast({ type: 'run-status', run: getRun(runId)! });
        return;
      }
      const errors = (await Promise.all(pending.map(runStep))).filter((e): e is Error => e !== null);
      setRunState(runId, state);
      if (errors.length) throw errors[0];
    }
    if (controller.signal.aborted) {
      // cancelRun already wrote 'cancelled'; the remaining steps are what never ran.
      for (const s of getRun(runId)!.steps) if (s.status === 'pending') setRunStep(runId, s.key, 'skipped');
      await finish(runId, 'cancelled', 'Cancelled.');
      return;
    }
    if (tryTransitionRun(runId, ['running'], 'done')) await finish(runId, 'done', null);
    else await finish(runId, 'cancelled', 'Cancelled.');
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`[runs] run ${runId} (${run.kind}) failed:`, message);
    setRunState(runId, state);
    for (const s of getRun(runId)!.steps) if (s.status === 'pending') setRunStep(runId, s.key, 'skipped');
    if (tryTransitionRun(runId, ['running'], 'failed', message)) await finish(runId, 'failed', message);
    else await finish(runId, 'cancelled', 'Cancelled.');
  }
}

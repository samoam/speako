import { Run, RunStep, RunStatus } from '../storage/runRepository';

/** What a step gets to work with: the run's mutable state (persisted after every step), a progress log, and a cancel signal. */
export interface StepContext<S> {
  runId: number;
  state: S;
  /** One progress line — persisted to run_events and broadcast live. */
  log(message: string): void;
  /** Updates this step's own live `detail` (what the checklist shows next to a running step) without ending it. */
  detail(message: string): void;
  /** Aborted when the run is cancelled — long-running steps should stop their child process on it. */
  signal: AbortSignal;
}

export interface StepDefinition<S> {
  key: string;
  label: string;
  /** Bounded wait; the engine fails the step with "<label> timed out after Ns" (the underlying promise keeps running — only the wait is bounded, as with the old withTimeout). */
  timeoutMs?: number;
  /** A failed optional step is recorded as failed and the run carries on (e.g. the second-opinion reviewer); a failed required step fails the run. */
  optional?: boolean;
  /** The run pauses at waiting_approval before this step until approveRun() is called — the approval survives a restart since state is persisted. */
  approval?: boolean;
  /** Resolves with the step's conclusion for the checklist (e.g. the review's summary), or nothing. */
  run(ctx: StepContext<S>): Promise<string | void>;
}

/** One entry of a run: a single step, or several steps that run in parallel (each with its own checklist line). */
export type StepEntry<S> = StepDefinition<S> | StepDefinition<S>[];

export type RunOutcome = 'done' | 'failed' | 'cancelled';

export interface RunDefinition<S> {
  kind: string;
  /** The step list for a given run, decided once up front so the UI can show the whole checklist immediately. */
  steps(state: S): StepEntry<S>[];
  /** Always called once the run ends, however it ended — cleanup (remove a worktree) and the kind's own result record (mark the review ready/failed). */
  finalize?(run: Run<S>, outcome: RunOutcome, error: string | null): Promise<void>;
  /** A run of this kind that a Speako restart interrupted is retried on startup from its interrupted step (its steps must be safe to re-enter) instead of left failed for the user to retry by hand. */
  resumeOnRestart?: boolean;
}

export type RunBroadcastEvent =
  | { type: 'run-status'; run: Run }
  | { type: 'run-step'; runId: number; kind: string; subjectKind: string; subjectId: string; step: RunStep }
  | { type: 'run-log'; runId: number; kind: string; subjectKind: string; subjectId: string; message: string };

export type { Run, RunStep, RunStatus };

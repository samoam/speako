import { Draft, DraftRevision, DraftSubjectKind } from '../storage/draftRepository';

/**
 * One human-approval step in a kind's gate chain. Most kinds have exactly
 * one ('send'/'submit'/'post'); a kind could have two (e.g. 'commit' then
 * 'push') — modeling gates as an ORDERED ARRAY rather than a single boolean
 * is what lets that be generic instead of special-cased.
 */
export interface DraftGate {
  key: string;
  label: string;
  confirmText?: string;
}

/** Context passed into observeSince()/generate() on a redo — see draftService.ts's redoDraft(). */
export interface RedoContext {
  priorContent: unknown;
  priorResultRef: unknown;
  priorHistory: DraftRevision[];
  /** Plain-text "what happened since" block from the completed draft's handler.observeSince(). */
  observed: string;
  strategy: 'follow_up' | 'amend' | 'fresh';
  instruction?: string;
}

export interface DraftGenerateInput<TSubject> {
  /** The draft this generation pass belongs to — mainly so a long-running generate() (e.g. a multi-minute Claude Code plan run) can stream progress via emitDraftLog(draftId, message) from draftService.ts. */
  draftId: number;
  subject: TSubject;
  /** Present on refine/redo turns — the content of the draft being revised. Undefined on the very first generation. */
  priorContent?: unknown;
  /** The refinement conversation so far, oldest first. Empty on the very first generation. */
  history: DraftRevision[];
  /** The user's newest instruction, present only on a refine turn. */
  instruction?: string;
  /** Present only on a redo turn (see RedoContext above). */
  redo?: RedoContext;
}

/**
 * `draft` replaces the draft's content; `answer` leaves it untouched and
 * just answers a question ("why did you flag this?") — this split is what
 * keeps a clarifying question from silently clobbering a draft the user was
 * about to approve. `question` is the assistant-initiated counterpart to
 * `answer`: content also stays untouched, but the draft lands in
 * 'awaiting_clarification' rather than 'ready' (see draftService.ts's
 * generateAndStore) since the assistant is the one waiting on a reply now,
 * not the user.
 */
export type DraftGenerateResult =
  | { mode: 'draft'; content: unknown; note?: string }
  | { mode: 'answer'; text: string }
  | { mode: 'question'; text: string };

export interface DraftExecuteContext<TSubject> {
  draft: Draft;
  subject: TSubject;
  content: any;
}

/**
 * The kind registry's contract (src/drafts/registry.ts). Each write-surface
 * (Teams reply, Jira action, PR comment, ...) registers one of these; the
 * generic draftService.ts never knows about any specific external system,
 * only this interface.
 */
export interface DraftHandler<TSubject = unknown> {
  kind: string;
  subjectKind: DraftSubjectKind;
  gates: DraftGate[];
  /** How a completed/failed draft is redone (see draftService.ts's redoDraft() and RedoContext above). */
  redoStrategy: 'follow_up' | 'amend' | 'fresh';
  /** Defaults to true. Set false for kinds where refinement isn't wired up (e.g. re-running a whole checklist per chat turn would be too expensive) — the Draft Panel hides the chat row. */
  supportsRefine?: boolean;
  loadSubject(subjectId: string): TSubject | undefined | Promise<TSubject | undefined>;
  generate(input: DraftGenerateInput<TSubject>): Promise<DraftGenerateResult>;
  /** Runs gates[draft.stage]. The returned object is merged into drafts.result_ref (last gate) or drafts.execution_ref (earlier gates). */
  execute(gateKey: string, ctx: DraftExecuteContext<TSubject>): Promise<Record<string, unknown>>;
  /** Optional cleanup when a non-terminal draft is discarded (e.g. stopping an agent, removing a worktree). */
  discard?(ctx: { draft: Draft; subject: TSubject }): Promise<void>;
  /** What changed on the target since a completed draft's execution — the "here's what happened since" context fed into a redo. */
  observeSince?(ctx: { draft: Draft; subject: TSubject }): Promise<string>;
  /**
   * Fires whatever legacy WebSocket events an old, not-yet-migrated UI
   * surface still listens for, so both coexist correctly during migration
   * (see the class-level comment in draftService.ts). Returns the event
   * payloads to broadcast — draftService.ts does the actual broadcasting,
   * so kind handlers never need direct access to the server's WS internals.
   */
  legacyBroadcast?(draft: Draft, phase: 'updated' | 'completed' | 'failed' | 'discarded'): Record<string, unknown>[] | void;
}

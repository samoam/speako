import * as repo from '../storage/draftRepository';
import { Draft, DraftRevision } from '../storage/draftRepository';
import { getDraftHandler } from './registry';
import { DraftHandler } from './types';

/** Thrown for any client-caused state mismatch (wrong status, wrong gate, unknown kind) — routes map this to HTTP 409/400 rather than 500. */
export class DraftConflictError extends Error {}

export type DraftBroadcast = (event: Record<string, unknown>) => void;

/** Set once from InterfaceServer's constructor — kept as a plain callback (not an import of the server) so this module has no dependency on express/ws, matching the onProgress-callback convention already used by runCodebaseIndex/PrepService/runClaudeCodeReview. */
let broadcast: DraftBroadcast = () => {};
export function setDraftBroadcast(fn: DraftBroadcast): void {
  broadcast = fn;
}

function emitUpdated(draft: Draft): void {
  broadcast({ type: 'draft-updated', draftId: draft.id, kind: draft.kind, subjectKind: draft.subjectKind, subjectId: draft.subjectId, status: draft.status, stage: draft.stage });
}

function emitRevision(draft: Draft, revision: DraftRevision): void {
  broadcast({ type: 'draft-revision', draftId: draft.id, revision });
}

/** For a kind handler's generate() to stream progress during a long-running pass (e.g. a multi-minute Claude Code run) — same purpose as pr_review_requests.log's live progress lines, just routed through the generic draft broadcast instead of a bespoke one. */
export function emitDraftLog(draftId: number, message: string): void {
  broadcast({ type: 'draft-log', draftId, message });
}

/** Lets a kind handler's execute() kick off its own background process that broadcasts independently of the draft's own lifecycle (e.g. src/drafts/kinds/devPlanDraft.ts dispatching pollCodeChangeRequest) — same underlying callback setDraftBroadcast wired up, just exposed for reuse rather than duplicated. */
export function getDraftBroadcaster(): DraftBroadcast {
  return broadcast;
}

function emitLegacy(handler: DraftHandler<any> | undefined, draft: Draft, phase: 'updated' | 'completed' | 'failed' | 'discarded'): void {
  const events = handler?.legacyBroadcast?.(draft, phase);
  events?.forEach((e) => broadcast(e));
}

function requireHandler(kind: string): DraftHandler<any> {
  const handler = getDraftHandler(kind);
  if (!handler) throw new Error(`Unknown draft kind "${kind}".`);
  return handler;
}

async function loadSubjectOrThrow<T>(handler: DraftHandler<T>, subjectId: string): Promise<T> {
  const subject = await handler.loadSubject(subjectId);
  if (subject === undefined) throw new DraftConflictError(`Unknown ${handler.subjectKind} "${subjectId}" for draft kind "${handler.kind}".`);
  return subject;
}

/** Runs one generation pass (first draft, a refine turn, or a redo turn) and persists whatever it produces. */
async function generateAndStore(handler: DraftHandler<any>, draft: Draft, subject: unknown, opts: { instruction?: string; redo?: any } = {}): Promise<void> {
  const history = repo.getDraftRevisions(draft.id);
  const result = await handler.generate({
    draftId: draft.id,
    subject,
    priorContent: draft.content ?? undefined,
    history,
    instruction: opts.instruction,
    redo: opts.redo,
  });

  let revision: DraftRevision;
  if (result.mode === 'draft') {
    revision = repo.appendDraftRevision({ draftId: draft.id, role: 'assistant', kind: 'draft', text: result.note, content: result.content });
    repo.setDraftContent(draft.id, result.content, { status: 'ready' });
  } else if (result.mode === 'question') {
    revision = repo.appendDraftRevision({ draftId: draft.id, role: 'assistant', kind: 'question', text: result.text });
    // Same shape as the 'answer' branch below — content untouched — but the
    // assistant is the one waiting on a reply now, not the user, so this
    // lands in 'awaiting_clarification' instead of 'ready' (blocks Approve).
    repo.tryTransitionDraft(draft.id, ['refining', 'generating'], 'awaiting_clarification');
  } else {
    revision = repo.appendDraftRevision({ draftId: draft.id, role: 'assistant', kind: 'answer', text: result.text });
    // Answering a question never advances stage/content — just returns the row to 'ready' from whatever in-flight status it was in.
    repo.tryTransitionDraft(draft.id, ['refining', 'generating'], 'ready');
  }

  const updated = repo.getDraft(draft.id)!;
  emitRevision(updated, revision);
  emitUpdated(updated);
  emitLegacy(handler, updated, 'updated');
}

export async function startDraft(params: { kind: string; subjectId: string | number }): Promise<Draft> {
  const handler = requireHandler(params.kind);
  const subject = await loadSubjectOrThrow(handler, String(params.subjectId));

  const draft = repo.createDraft({ kind: handler.kind, subjectKind: handler.subjectKind, subjectId: params.subjectId });
  emitUpdated(draft);

  generateAndStore(handler, draft, subject).catch((err: any) => {
    repo.setDraftError(draft.id, err?.message || String(err));
    emitUpdated(repo.getDraft(draft.id)!);
  });

  return draft;
}

export async function refineDraft(draftId: number, instruction: string): Promise<Draft> {
  const draft = repo.getDraft(draftId);
  if (!draft) throw new DraftConflictError('Unknown draft.');
  const handler = requireHandler(draft.kind);
  if (handler.supportsRefine === false) throw new DraftConflictError(`Draft kind "${draft.kind}" does not support refinement yet.`);

  // 'awaiting_clarification' is included so answering a pending clarifying
  // question goes through this exact same "type an instruction, hit Refine"
  // path as any other chat turn — the kind handler's generate() is what
  // recognizes the newest instruction as resolving the question rather than
  // just being a generic style tweak.
  if (!repo.tryTransitionDraft(draftId, ['ready', 'awaiting_clarification'], 'refining')) {
    throw new DraftConflictError(`Cannot refine a draft in status "${draft.status}" — must be "ready" or "awaiting_clarification".`);
  }

  // Everything from here on runs against a row already in 'refining' —
  // any throw (unknown subject, a failed Gemini call, ...) must still land
  // the row in 'failed' rather than leaving it stuck in 'refining' forever.
  try {
    const subject = await loadSubjectOrThrow(handler, draft.subjectId);
    const instructionRevision = repo.appendDraftRevision({ draftId, role: 'user', kind: 'instruction', text: instruction });
    const afterInstruction = repo.getDraft(draftId)!;
    emitRevision(afterInstruction, instructionRevision);
    emitUpdated(afterInstruction);

    await generateAndStore(handler, afterInstruction, subject, { instruction });
    return repo.getDraft(draftId)!;
  } catch (err: any) {
    repo.setDraftError(draftId, err?.message || String(err));
    emitUpdated(repo.getDraft(draftId)!);
    throw err;
  }
}

/** Direct field edit (no chat instruction) — recorded as a 'manual_edit' revision so refinement history shows when the user changed something themselves rather than asking Speako to. */
export function editDraftContent(draftId: number, content: unknown): Draft {
  const draft = repo.getDraft(draftId);
  if (!draft) throw new DraftConflictError('Unknown draft.');
  if (draft.status !== 'ready') throw new DraftConflictError(`Cannot edit a draft in status "${draft.status}" — must be "ready".`);

  const revision = repo.appendDraftRevision({ draftId, role: 'user', kind: 'manual_edit', content });
  repo.setDraftContent(draftId, content);
  const updated = repo.getDraft(draftId)!;
  emitRevision(updated, revision);
  emitUpdated(updated);
  return updated;
}

export async function approveDraftGate(draftId: number, expectedGateKey?: string): Promise<Draft> {
  const draft = repo.getDraft(draftId);
  if (!draft) throw new DraftConflictError('Unknown draft.');
  const handler = requireHandler(draft.kind);

  const gate = handler.gates[draft.stage];
  if (!gate) throw new DraftConflictError('This draft has no pending approval gate.');
  if (expectedGateKey && expectedGateKey !== gate.key) {
    throw new DraftConflictError(`Expected to approve gate "${expectedGateKey}" but the pending gate is "${gate.key}".`);
  }

  if (!repo.tryTransitionDraft(draftId, ['ready'], 'executing')) {
    throw new DraftConflictError(`Cannot approve a draft in status "${draft.status}" — must be "ready".`);
  }
  emitUpdated(repo.getDraft(draftId)!);

  // Subject lookup is inside the try, not before it — a throw here must
  // still land the row in 'failed', not leave it stuck in 'executing'.
  try {
    const subject = await loadSubjectOrThrow(handler, draft.subjectId);
    const result = await handler.execute(gate.key, { draft, subject, content: draft.content });
    const isLastGate = draft.stage + 1 >= handler.gates.length;
    if (isLastGate) {
      repo.completeDraft(draftId, result);
    } else {
      repo.setDraftExecutionRef(draftId, { ...(draft.executionRef ?? {}), ...result });
      repo.advanceDraftStage(draftId);
    }
    const updated = repo.getDraft(draftId)!;
    emitUpdated(updated);
    emitLegacy(handler, updated, isLastGate ? 'completed' : 'updated');
    return updated;
  } catch (err: any) {
    repo.setDraftError(draftId, err?.message || String(err));
    const updated = repo.getDraft(draftId)!;
    emitUpdated(updated);
    emitLegacy(handler, updated, 'failed');
    throw err;
  }
}

export async function discardDraft(draftId: number): Promise<Draft> {
  const draft = repo.getDraft(draftId);
  if (!draft) throw new DraftConflictError('Unknown draft.');
  if (!(['generating', 'ready', 'refining', 'failed', 'awaiting_clarification'] as const).includes(draft.status as any)) {
    throw new DraftConflictError(`Cannot discard a draft in status "${draft.status}".`);
  }
  const handler = getDraftHandler(draft.kind);

  if (handler) {
    const subject = await handler.loadSubject(draft.subjectId);
    if (subject !== undefined) await handler.discard?.({ draft, subject });
  }

  repo.discardDraft(draftId);
  const updated = repo.getDraft(draftId)!;
  emitUpdated(updated);
  emitLegacy(handler, updated, 'discarded');
  return updated;
}

/**
 * Redo covers what happens AFTER a draft's last gate already executed —
 * generates a brand-new draft (linked via redoOfDraftId/supersededByDraftId)
 * seeded with handler.observeSince()'s "what happened since" context, so a
 * Teams-reply redo can see the recipient's response, a Jira-transition redo
 * can see the ticket's current state, etc. The original draft's row is never
 * mutated — it stays the permanent record of what was actually sent/applied.
 */
export async function redoDraft(draftId: number, instruction?: string): Promise<Draft> {
  const original = repo.getDraft(draftId);
  if (!original) throw new DraftConflictError('Unknown draft.');
  if (!(['completed', 'failed'] as const).includes(original.status as any)) {
    throw new DraftConflictError(`Cannot redo a draft in status "${original.status}" — must be "completed" or "failed".`);
  }
  const handler = requireHandler(original.kind);
  const subject = await loadSubjectOrThrow(handler, original.subjectId);

  let observed = '';
  try {
    observed = (await handler.observeSince?.({ draft: original, subject })) || '';
  } catch {
    // observeSince is a best-effort context enrichment — never blocks a redo.
  }
  const priorHistory = repo.getDraftRevisions(original.id);

  const redo = repo.createDraft({ kind: handler.kind, subjectKind: handler.subjectKind, subjectId: original.subjectId, redoOfDraftId: original.id });
  repo.supersedeDraft(original.id, redo.id);
  emitUpdated(repo.getDraft(original.id)!);
  emitUpdated(redo);

  generateAndStore(handler, redo, subject, {
    instruction,
    redo: { priorContent: original.content, priorResultRef: original.resultRef, priorHistory, observed, strategy: handler.redoStrategy, instruction },
  }).catch((err: any) => {
    repo.setDraftError(redo.id, err?.message || String(err));
    emitUpdated(repo.getDraft(redo.id)!);
  });

  return repo.getDraft(redo.id)!;
}

/** Startup reconciliation for rows left mid-flight by a restart (generating/refining/executing) — same class of problem getRunningCodeChangeRequests() targets for code_change_requests. Marks them failed with an honest reason rather than leaving them stuck forever; the user can Redo from there once the underlying action's real state is confirmed. */
export async function reconcileStuckDrafts(): Promise<void> {
  const stuck = repo.getActiveDraftsByStatus(['generating', 'refining', 'executing']);
  for (const draft of stuck) {
    repo.setDraftError(draft.id, 'Speako restarted while this draft was in progress.');
  }
}

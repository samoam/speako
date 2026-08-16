export type LifecycleState = 'Evaluation' | 'On Hold' | 'Dev Ready' | 'In Progress' | 'QA Ready' | 'Return' | 'Release';

/**
 * The ONLY transitions Speako will ever propose — anything not in this map
 * is not proposable, full stop (see assertProposable below). Matches the
 * blueprint's §5.2 fixed lifecycle:
 *
 *   Evaluation -> On Hold -> Dev Ready -> In Progress -> QA Ready -> Release
 *                                              ^              |
 *                                              +---- Return --+
 *                                        (loops back to In Progress,
 *                                         then QA Ready again, until accepted)
 */
export const LIFECYCLE_GRAPH: Record<LifecycleState, LifecycleState[]> = {
  Evaluation: ['On Hold', 'Dev Ready'],
  'On Hold': ['Dev Ready'],
  'Dev Ready': ['In Progress'],
  'In Progress': ['QA Ready'],
  'QA Ready': ['Release', 'Return'],
  Return: ['In Progress'],
  Release: [],
};

/**
 * How the real Jira workflow may spell each state — tunable in one place
 * without touching the graph itself. A given team's workflow may use any of
 * these as the actual status/transition name; resolveTransition (jiraTransitions.ts)
 * tries the canonical name first, then these aliases.
 */
export const STATE_ALIASES: Record<LifecycleState, string[]> = {
  Evaluation: ['evaluation', 'evaluating', 'triage', 'new', 'open', 'backlog'],
  'On Hold': ['on hold', 'hold', 'blocked', 'paused'],
  'Dev Ready': ['dev ready', 'ready for dev', 'ready for development', 'todo', 'to do', 'selected for development'],
  'In Progress': ['in progress', 'in development', 'in dev'],
  'QA Ready': ['qa ready', 'ready for qa', 'ready for test', 'in qa', 'in review'],
  Return: ['return', 'returned', 'rejected', 'reopened', 'failed qa'],
  Release: ['release', 'released', 'ready for release', 'done', 'closed'],
};

/** lowercase, collapse whitespace/punctuation runs to a single space, trim. */
export function normalizeStatusName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Maps a live Jira status name to one of our six lifecycle states, via the canonical name or STATE_ALIASES. Null if it doesn't match anything we recognize (a bespoke project status outside our graph) — callers must propose nothing in that case, not guess. */
export function toLifecycleState(jiraStatusName: string): LifecycleState | null {
  const normalized = normalizeStatusName(jiraStatusName);
  for (const state of Object.keys(LIFECYCLE_GRAPH) as LifecycleState[]) {
    if (normalizeStatusName(state) === normalized) return state;
  }
  for (const state of Object.keys(STATE_ALIASES) as LifecycleState[]) {
    if (STATE_ALIASES[state].some((alias) => normalizeStatusName(alias) === normalized)) return state;
  }
  return null;
}

export function nextStates(from: LifecycleState): LifecycleState[] {
  return LIFECYCLE_GRAPH[from] ?? [];
}

export function isProposableTransition(from: LifecycleState, to: LifecycleState): boolean {
  return nextStates(from).includes(to);
}

/** The single enforcement point — throws if `to` is not a valid next state from `from`. Called both when drafting a transition AND again at approve time (the ticket may have moved since). */
export function assertProposable(from: LifecycleState, to: LifecycleState): void {
  if (!isProposableTransition(from, to)) {
    throw new Error(`"${from} -> ${to}" is not a valid transition — from "${from}" Speako may only propose: ${nextStates(from).join(', ') || '(nothing — this is a terminal state)'}.`);
  }
}

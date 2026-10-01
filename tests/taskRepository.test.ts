import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertTask,
  getOpenTasks,
  getTaskById,
  dismissTask,
  undismissTask,
  getDismissedTasks,
  pruneTasksForSource,
  updateTaskBoardStatus,
  getTasksCreatedSince,
  snoozeTask,
  clearSnooze,
  setTaskPriorityOverride,
  setTaskDueDate,
} from '../src/storage/taskRepository';
import { createDevCycle } from '../src/storage/devCycleRepository';

function baseTask(overrides: Partial<Parameters<typeof upsertTask>[0]> = {}) {
  return {
    source: 'jira' as const,
    externalRef: 'ETICK-1',
    title: 'Fix the thing',
    urgencyScore: 3,
    importanceScore: 3,
    ...overrides,
  };
}

test('taskRepository: upsertTask then getOpenTasks round-trips a task, computing priority_score', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-100', urgencyScore: 4, importanceScore: 5 }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-100');
  assert.ok(task);
  assert.equal(task!.urgencyScore, 4);
  assert.equal(task!.importanceScore, 5);
  assert.equal(task!.priorityScore, 20);
  assert.equal(task!.status, 'open');
});

test('taskRepository: getOpenTasks sorts by priority_score descending', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-200', urgencyScore: 1, importanceScore: 1 })); // 1
  upsertTask(baseTask({ externalRef: 'ETICK-201', urgencyScore: 5, importanceScore: 5 })); // 25
  const tasks = getOpenTasks().filter((t) => ['ETICK-200', 'ETICK-201'].includes(t.externalRef));
  assert.deepEqual(
    tasks.map((t) => t.externalRef),
    ['ETICK-201', 'ETICK-200']
  );
});

test('taskRepository: upserting the same (source, externalRef) updates in place, not a new row', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-300', title: 'Old title', urgencyScore: 2, importanceScore: 2 }));
  upsertTask(baseTask({ externalRef: 'ETICK-300', title: 'New title', urgencyScore: 4, importanceScore: 4 }));
  const matches = getOpenTasks().filter((t) => t.externalRef === 'ETICK-300');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, 'New title');
  assert.equal(matches[0].priorityScore, 16);
});

test('taskRepository: dismissTask removes it from getOpenTasks', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-400' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-400')!;
  dismissTask(task.id);
  assert.ok(!getOpenTasks().some((t) => t.id === task.id));
});

test('taskRepository: re-upserting a dismissed-but-still-present task does not resurrect it as open', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-500' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-500')!;
  dismissTask(task.id);
  upsertTask(baseTask({ externalRef: 'ETICK-500', title: 'Still the same issue' }));
  assert.ok(!getOpenTasks().some((t) => t.externalRef === 'ETICK-500'));
});

test('taskRepository: pruneTasksForSource removes tasks for that source not in the keep list', () => {
  upsertTask(baseTask({ source: 'bitbucket_pr', externalRef: 'PROJ/repo#1' }));
  upsertTask(baseTask({ source: 'bitbucket_pr', externalRef: 'PROJ/repo#2' }));
  pruneTasksForSource('bitbucket_pr', ['PROJ/repo#1']);
  const remaining = getOpenTasks().filter((t) => t.source === 'bitbucket_pr');
  assert.deepEqual(
    remaining.map((t) => t.externalRef).sort(),
    ['PROJ/repo#1']
  );
});

test('taskRepository: pruneTasksForSource with an empty keep list removes every task for that source', () => {
  upsertTask(baseTask({ source: 'action_item', externalRef: '1' }));
  upsertTask(baseTask({ source: 'action_item', externalRef: '2' }));
  pruneTasksForSource('action_item', []);
  assert.equal(getOpenTasks().filter((t) => t.source === 'action_item').length, 0);
});

test('taskRepository: pruneTasksForSource skips (rather than throws on) a task that a dev_cycle still points at', () => {
  upsertTask(baseTask({ source: 'jira', externalRef: 'ETICK-9001' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-9001')!;
  createDevCycle({
    ticketKey: 'ETICK-9001',
    taskId: task.id,
    repoName: 'officercc',
    repoPath: 'C:\\repos\\officercc',
    branchType: 'feature',
    lifecycleState: 'In Progress',
  });

  // The ticket no longer shows up in "my open issues" (e.g. it was
  // transitioned/closed) — this used to throw "FOREIGN KEY constraint
  // failed" and abort the whole prune for the source, per ETICK-10052.
  assert.doesNotThrow(() => pruneTasksForSource('jira', []));

  const survivor = getTaskById(task.id);
  assert.ok(survivor, 'task referenced by a dev_cycle must survive pruning');
  assert.equal(survivor!.externalRef, 'ETICK-9001');
  // It can't be deleted, but it no longer qualifies — dismissed instead of
  // left stuck 'open' forever (this used to just skip it silently).
  assert.equal(survivor!.status, 'dismissed');
});

test('taskRepository: pruneTasksForSource dismisses (not deletes) a referenced task once it drops out of the keep list', () => {
  upsertTask(baseTask({ source: 'bitbucket_pr', externalRef: 'PROJ/repo#9002' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'PROJ/repo#9002')!;
  createDevCycle({
    ticketKey: 'PROJ-9002',
    taskId: task.id,
    repoName: 'officercc',
    repoPath: 'C:\\repos\\officercc',
    branchType: 'feature',
    lifecycleState: 'In Progress',
  });

  pruneTasksForSource('bitbucket_pr', ['PROJ/repo#other']);
  assert.equal(getTaskById(task.id)?.status, 'dismissed');
});

test('taskRepository: pruneTasksForSource leaves a referenced task open while it is still in the keep list', () => {
  upsertTask(baseTask({ source: 'bitbucket_pr', externalRef: 'PROJ/repo#9003' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'PROJ/repo#9003')!;
  createDevCycle({
    ticketKey: 'PROJ-9003',
    taskId: task.id,
    repoName: 'officercc',
    repoPath: 'C:\\repos\\officercc',
    branchType: 'feature',
    lifecycleState: 'In Progress',
  });

  pruneTasksForSource('bitbucket_pr', ['PROJ/repo#9003']);
  assert.equal(getTaskById(task.id)?.status, 'open');
});

test('taskRepository: a new task defaults to board_status "todo"', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-600' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-600');
  assert.equal(task!.boardStatus, 'todo');
});

test('taskRepository: updateTaskBoardStatus moves a task to a new column', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-700' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-700')!;
  updateTaskBoardStatus(task.id, 'in_progress');
  const updated = getOpenTasks().find((t) => t.id === task.id);
  assert.equal(updated!.boardStatus, 'in_progress');
});

test('taskRepository: re-upserting a moved task does not snap board_status back to "todo"', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-800', title: 'Original' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-800')!;
  updateTaskBoardStatus(task.id, 'done');
  upsertTask(baseTask({ externalRef: 'ETICK-800', title: 'Re-synced title' }));
  const updated = getOpenTasks().find((t) => t.externalRef === 'ETICK-800');
  assert.equal(updated!.boardStatus, 'done');
  assert.equal(updated!.title, 'Re-synced title');
});

test('taskRepository: getTaskById returns the matching task, undefined for an unknown id', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-900' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-900')!;
  assert.equal(getTaskById(task.id)?.externalRef, 'ETICK-900');
  assert.equal(getTaskById(-1), undefined);
});

test('taskRepository: getTasksCreatedSince only returns open tasks first seen at or after the cutoff', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1000' }));
  const cutoff = new Date(Date.now() + 60_000).toISOString(); // safely after the row just inserted
  assert.ok(!getTasksCreatedSince(cutoff).some((t) => t.externalRef === 'ETICK-1000'));
  const pastCutoff = new Date(Date.now() - 60_000).toISOString();
  assert.ok(getTasksCreatedSince(pastCutoff).some((t) => t.externalRef === 'ETICK-1000'));
});

test('taskRepository: getTasksCreatedSince excludes dismissed tasks', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1001' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1001')!;
  dismissTask(task.id);
  const pastCutoff = new Date(Date.now() - 60_000).toISOString();
  assert.ok(!getTasksCreatedSince(pastCutoff).some((t) => t.externalRef === 'ETICK-1001'));
});

test('taskRepository: undismissTask returns a dismissed task to open, and it drops off getDismissedTasks', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1100' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1100')!;
  dismissTask(task.id);
  assert.ok(getDismissedTasks().some((t) => t.id === task.id));
  undismissTask(task.id);
  assert.equal(getTaskById(task.id)?.status, 'open');
  assert.ok(getOpenTasks().some((t) => t.id === task.id));
  assert.ok(!getDismissedTasks().some((t) => t.id === task.id));
});

test('taskRepository: a task snoozed into the future is hidden from getOpenTasks/getTasksCreatedSince', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1200' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1200')!;
  snoozeTask(task.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
  assert.ok(!getOpenTasks().some((t) => t.id === task.id));
  const pastCutoff = new Date(Date.now() - 60_000).toISOString();
  assert.ok(!getTasksCreatedSince(pastCutoff).some((t) => t.id === task.id));
  // Still fetchable directly — snoozing hides it from the queue views only, doesn't dismiss it.
  assert.equal(getTaskById(task.id)?.status, 'open');
});

test('taskRepository: a task snoozed into the past reappears in getOpenTasks', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1201' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1201')!;
  snoozeTask(task.id, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  assert.ok(getOpenTasks().some((t) => t.id === task.id));
});

test('taskRepository: clearSnooze un-hides a still-future-snoozed task immediately', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1202' }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1202')!;
  snoozeTask(task.id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
  assert.ok(!getOpenTasks().some((t) => t.id === task.id));
  clearSnooze(task.id);
  assert.ok(getOpenTasks().some((t) => t.id === task.id));
});

test('taskRepository: a priority override survives a re-sync with different urgency/importance', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1300', urgencyScore: 3, importanceScore: 3 })); // priority_score 9
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1300')!;
  setTaskPriorityOverride(task.id, 25);
  assert.equal(getTaskById(task.id)?.priorityScore, 25);

  upsertTask(baseTask({ externalRef: 'ETICK-1300', urgencyScore: 1, importanceScore: 1 })); // would compute to 1
  const resynced = getTaskById(task.id)!;
  assert.equal(resynced.priorityScore, 25); // override still wins
  assert.equal(resynced.priorityOverride, 25);
});

test('taskRepository: clearing a priority override (null) reverts to the computed score immediately', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1301', urgencyScore: 2, importanceScore: 3 })); // 6
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1301')!;
  setTaskPriorityOverride(task.id, 25);
  setTaskPriorityOverride(task.id, null);
  const updated = getTaskById(task.id)!;
  assert.equal(updated.priorityOverride, null);
  assert.equal(updated.priorityScore, 6); // urgency * importance from the row's last upsert
});

test('taskRepository: a manual due date survives a re-sync from a source with no due date of its own', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1400', source: 'teams_message', dueDate: null }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1400')!;
  setTaskDueDate(task.id, '2026-12-25');
  assert.equal(getTaskById(task.id)?.dueDate, '2026-12-25');
  assert.equal(getTaskById(task.id)?.dueDateIsManual, true);

  upsertTask(baseTask({ externalRef: 'ETICK-1400', source: 'teams_message', dueDate: null }));
  const resynced = getTaskById(task.id)!;
  assert.equal(resynced.dueDate, '2026-12-25'); // manual date preserved, not overwritten with null
});

test('taskRepository: clearing a manual due date (null) lets the next sync repopulate it from the source', () => {
  upsertTask(baseTask({ externalRef: 'ETICK-1401', dueDate: null }));
  const task = getOpenTasks().find((t) => t.externalRef === 'ETICK-1401')!;
  setTaskDueDate(task.id, '2026-12-25');
  setTaskDueDate(task.id, null);
  assert.equal(getTaskById(task.id)?.dueDateIsManual, false);

  upsertTask(baseTask({ externalRef: 'ETICK-1401', dueDate: '2027-01-01' }));
  assert.equal(getTaskById(task.id)?.dueDate, '2027-01-01');
});


test('taskRepository: occurredAt follows the source on re-sync, but a sync without one keeps the last known time', () => {
  const externalRef = `occurred-${Date.now()}`;
  upsertTask(baseTask({ externalRef, occurredAt: '2026-09-29T10:00:00.000Z' }));
  const id = getOpenTasks().find((t) => t.externalRef === externalRef)!.id;
  assert.equal(getTaskById(id)!.occurredAt, '2026-09-29T10:00:00.000Z');

  // A Jira issue's "updated" moves forward — the card should too.
  upsertTask(baseTask({ externalRef, occurredAt: '2026-09-30T12:00:00.000Z' }));
  assert.equal(getTaskById(id)!.occurredAt, '2026-09-30T12:00:00.000Z');

  // A source that momentarily reports no time must not erase the one already known.
  upsertTask(baseTask({ externalRef }));
  assert.equal(getTaskById(id)!.occurredAt, '2026-09-30T12:00:00.000Z');
});

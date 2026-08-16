import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask, getOpenTasks, getTaskById, dismissTask, pruneTasksForSource, updateTaskBoardStatus, getTasksCreatedSince } from '../src/storage/taskRepository';

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


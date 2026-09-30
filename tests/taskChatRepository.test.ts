import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertTask, getOpenTasks } from '../src/storage/taskRepository';
import { appendTaskChatMessage, getTaskChatMessages } from '../src/storage/taskChatRepository';

/** task_chat_messages.task_id has a real foreign key to tasks(id), enforced in this environment — seed a real task row rather than using an arbitrary id. */
function seedTaskId(externalRef: string): number {
  upsertTask({ source: 'jira', externalRef, title: 'A ticket', urgencyScore: 3, importanceScore: 3 });
  return getOpenTasks().find((t) => t.source === 'jira' && t.externalRef === externalRef)!.id;
}

test('appendTaskChatMessage: assigns increasing turns per task', () => {
  const taskId = seedTaskId('task-chat-repo-test/1');
  const first = appendTaskChatMessage(taskId, 'user', 'What is the status of this?');
  const second = appendTaskChatMessage(taskId, 'assistant', "It's still open.");
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 2);
  assert.equal(first.role, 'user');
  assert.equal(second.role, 'assistant');
});

test('appendTaskChatMessage: turns are scoped independently per task', () => {
  const taskA = seedTaskId('task-chat-repo-test/2a');
  const taskB = seedTaskId('task-chat-repo-test/2b');
  appendTaskChatMessage(taskA, 'user', 'Question for task A');
  const otherTaskFirst = appendTaskChatMessage(taskB, 'user', 'Question for task B');
  assert.equal(otherTaskFirst.turn, 1); // not affected by task A's turn count
});

test('getTaskChatMessages: returns messages in turn order, scoped to the given task', () => {
  const taskId = seedTaskId('task-chat-repo-test/3');
  const otherTaskId = seedTaskId('task-chat-repo-test/3-other');
  appendTaskChatMessage(taskId, 'user', 'First question');
  appendTaskChatMessage(taskId, 'assistant', 'First answer');
  appendTaskChatMessage(taskId, 'user', 'Follow-up question');
  appendTaskChatMessage(otherTaskId, 'user', 'A different task entirely');

  const messages = getTaskChatMessages(taskId);
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.text), ['First question', 'First answer', 'Follow-up question']);
  assert.deepEqual(messages.map((m) => m.turn), [1, 2, 3]);
  assert.ok(messages.every((m) => m.taskId === taskId));
});

test('getTaskChatMessages: returns an empty array for a task with no chat history', () => {
  const taskId = seedTaskId('task-chat-repo-test/4');
  assert.deepEqual(getTaskChatMessages(taskId), []);
});

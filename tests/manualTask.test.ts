import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as jiraMcp from '../src/integrations/jiraMcp';
import * as bitbucketServer from '../src/integrations/bitbucketServer';
import { addManualTask, parseManualTaskRef, ManualTaskNotFoundError, ManualTaskRefError } from '../src/orchestrator/manualTask';
import { pruneTasksForSource, getTaskByExternalRef } from '../src/storage/taskRepository';

test('parseManualTaskRef: recognizes a bare Jira key', () => {
  assert.deepEqual(parseManualTaskRef('ETICK-10052'), { kind: 'jira', key: 'ETICK-10052' });
});

test('parseManualTaskRef: is case-insensitive on the Jira key', () => {
  assert.deepEqual(parseManualTaskRef('etick-10052'), { kind: 'jira', key: 'ETICK-10052' });
});

test('parseManualTaskRef: recognizes a Bitbucket PR ref', () => {
  assert.deepEqual(parseManualTaskRef('GTEE/officercc#1651'), {
    kind: 'bitbucket_pr',
    projectKey: 'GTEE',
    repoSlug: 'officercc',
    pullRequestId: 1651,
  });
});

test('parseManualTaskRef: rejects an empty ref', () => {
  assert.throws(() => parseManualTaskRef('   '), ManualTaskRefError);
});

test('parseManualTaskRef: rejects a ref that is neither shape', () => {
  assert.throws(() => parseManualTaskRef('not a valid ref'), ManualTaskRefError);
});

test('addManualTask: adds a Jira issue as a manually_added task', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getJiraIssueByKey', async (key: string) => ({
      key,
      summary: 'Esweep missing inspector name',
      url: `https://jira.example/browse/${key}`,
      priorityName: 'High',
      statusName: 'In Progress',
      dueDate: null,
      updated: null,
    })),
  ];
  try {
    const task = await addManualTask('ETICK-10052');
    assert.equal(task.source, 'jira');
    assert.equal(task.externalRef, 'ETICK-10052');
    assert.equal(task.title, 'ETICK-10052: Esweep missing inspector name');
    assert.equal(task.manuallyAdded, true);
    assert.equal(task.importanceScore, 4); // High
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('addManualTask: throws ManualTaskNotFoundError for an unknown Jira key', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getJiraIssueByKey', async () => null),
  ];
  try {
    await assert.rejects(() => addManualTask('ETICK-99999'), ManualTaskNotFoundError);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('addManualTask: adds a Bitbucket PR as a manually_added task', async () => {
  const spies = [
    mock.method(bitbucketServer, 'getPullRequest', async (projectKey: string, repoSlug: string, id: number) => ({
      id,
      title: 'Fix inspector name lookup',
      state: 'OPEN',
      projectKey,
      repoSlug,
      authorName: 'Jane Doe',
      link: `https://bitbucket.example/projects/${projectKey}/repos/${repoSlug}/pull-requests/${id}`,
      myApprovalStatus: undefined,
      createdDate: new Date().toISOString(),
      description: null,
      fromRefDisplayId: 'feature/foo',
      toRefDisplayId: 'main',
    })),
  ];
  try {
    const task = await addManualTask('GTEE/officercc#1651');
    assert.equal(task.source, 'bitbucket_pr');
    assert.equal(task.externalRef, 'GTEE/officercc#1651');
    assert.equal(task.title, 'Fix inspector name lookup');
    assert.equal(task.manuallyAdded, true);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('addManualTask: throws ManualTaskNotFoundError when Bitbucket fetch fails', async () => {
  const spies = [mock.method(bitbucketServer, 'getPullRequest', async () => { throw new Error('404 Not Found'); })];
  try {
    await assert.rejects(() => addManualTask('GTEE/officercc#999999'), ManualTaskNotFoundError);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('addManualTask: a manually-added task survives pruneTasksForSource on the next sync', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getJiraIssueByKey', async (key: string) => ({
      key,
      summary: 'Not assigned to me',
      url: `https://jira.example/browse/${key}`,
      priorityName: null,
      statusName: null,
      dueDate: null,
      updated: null,
    })),
  ];
  try {
    await addManualTask('ETICK-8001');
    // Simulates syncJira()'s prune call after a sync where this ticket isn't
    // in the user's "my open issues" refs (it's not assigned to them).
    pruneTasksForSource('jira', []);
    assert.ok(getTaskByExternalRef('jira', 'ETICK-8001'), 'manually-added task must not be pruned');
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

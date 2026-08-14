import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as jiraMcp from '../src/integrations/jiraMcp';
import * as bitbucketServer from '../src/integrations/bitbucketServer';
import * as bitbucketReviews from '../src/integrations/bitbucketReviews';
import * as summaryRepository from '../src/storage/summaryRepository';
import { syncTasks } from '../src/orchestrator/taskSync';
import { getOpenTasks } from '../src/storage/taskRepository';

function emptyActivity() {
  return { reviewRequests: [], commentsOnMyPRs: [], mentionsOfMe: [] };
}

function mockAllUnconfigured() {
  return [
    mock.method(jiraMcp, 'isJiraConfigured', () => false),
    mock.method(bitbucketServer, 'isBitbucketConfigured', () => false),
    mock.method(summaryRepository, 'getAllOpenActionItems', () => []),
  ];
}

test('syncTasks: skips unconfigured sources silently and still succeeds', async () => {
  const spies = mockAllUnconfigured();
  try {
    const result = await syncTasks();
    assert.deepEqual(result.synced.sort(), ['action_items', 'bitbucket', 'jira']);
    assert.deepEqual(result.failed, []);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('syncTasks: Jira issues are upserted with priority-derived scoring', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getMyOpenJiraIssues', async () => [
      { key: 'ETICK-1', summary: 'Fix login bug', url: 'https://jira.example/browse/ETICK-1', priorityName: 'Blocker', statusName: 'In Progress', dueDate: null, updated: null },
    ]),
    mock.method(bitbucketServer, 'isBitbucketConfigured', () => false),
    mock.method(summaryRepository, 'getAllOpenActionItems', () => []),
  ];
  try {
    await syncTasks();
    const task = getOpenTasks().find((t) => t.source === 'jira' && t.externalRef === 'ETICK-1');
    assert.ok(task);
    assert.equal(task!.importanceScore, 5); // Blocker
    assert.equal(task!.url, 'https://jira.example/browse/ETICK-1');
    assert.match(task!.title, /ETICK-1/);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('syncTasks: Bitbucket review requests and mentions both become bitbucket_pr tasks', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => false),
    mock.method(bitbucketServer, 'isBitbucketConfigured', () => true),
    mock.method(bitbucketReviews, 'getPullRequestActivity', async () => ({
      reviewRequests: [
        { id: 42, title: 'Add caching', state: 'OPEN', projectKey: 'PROJ', repoSlug: 'repo', authorName: 'alice', link: 'https://bitbucket.example/PROJ/repo/pr/42', myApprovalStatus: 'UNAPPROVED', createdDate: new Date().toISOString() },
      ],
      commentsOnMyPRs: [],
      mentionsOfMe: [
        { prId: 7, prTitle: 'Refactor auth', projectKey: 'PROJ', repoSlug: 'repo', authorName: 'bob', text: '@me can you check this?', createdDate: '2026-01-01T00:00:00.000Z' },
      ],
    })),
    mock.method(summaryRepository, 'getAllOpenActionItems', () => []),
  ];
  try {
    await syncTasks();
    const tasks = getOpenTasks().filter((t) => t.source === 'bitbucket_pr');
    assert.ok(tasks.some((t) => t.externalRef === 'PROJ/repo#42' && t.importanceScore === 4));
    assert.ok(tasks.some((t) => t.externalRef.startsWith('PROJ/repo#7:') && t.title.includes('Refactor auth')));
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('syncTasks: cross-session open action items become action_item tasks with a session:// pseudo-url', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => false),
    mock.method(bitbucketServer, 'isBitbucketConfigured', () => false),
    mock.method(summaryRepository, 'getAllOpenActionItems', () => [
      {
        id: 999,
        sessionId: 'session-abc',
        sessionName: 'Sprint Planning',
        owner: null,
        description: 'Follow up with design team',
        dueDate: null,
        status: 'open',
        confidence: 'explicit',
        type: 'general',
        externalRef: null,
      },
    ]),
  ];
  try {
    await syncTasks();
    const task = getOpenTasks().find((t) => t.source === 'action_item' && t.externalRef === '999');
    assert.ok(task);
    assert.equal(task!.url, 'session://session-abc');
    assert.equal(task!.importanceScore, 4); // explicit
    assert.match(task!.description ?? '', /Sprint Planning/);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('syncTasks: one source failing does not prevent the others from syncing', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => true),
    mock.method(jiraMcp, 'getMyOpenJiraIssues', async () => {
      throw new Error('Jira is down');
    }),
    mock.method(bitbucketServer, 'isBitbucketConfigured', () => true),
    mock.method(bitbucketReviews, 'getPullRequestActivity', async () => emptyActivity()),
    mock.method(summaryRepository, 'getAllOpenActionItems', () => []),
  ];
  try {
    const result = await syncTasks();
    assert.deepEqual(result.failed, ['jira']);
    assert.deepEqual(result.synced.sort(), ['action_items', 'bitbucket']);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

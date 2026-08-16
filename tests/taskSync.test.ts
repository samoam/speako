import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as jiraMcp from '../src/integrations/jiraMcp';
import * as bitbucketServer from '../src/integrations/bitbucketServer';
import * as bitbucketReviews from '../src/integrations/bitbucketReviews';
import * as summaryRepository from '../src/storage/summaryRepository';
import * as jenkinsClientModule from '../src/integrations/jenkinsClient';
import * as jenkinsBuildRepositoryModule from '../src/storage/jenkinsBuildRepository';
import { syncTasks } from '../src/orchestrator/taskSync';
import { getOpenTasks } from '../src/storage/taskRepository';
import { db } from '../src/storage/db';

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
    assert.deepEqual(result.synced.sort(), ['action_items', 'bitbucket', 'email_messages', 'jenkins', 'jira', 'teams_messages']);
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

test('syncTasks: triaged Teams messages become teams_message tasks with recency-based urgency and title shaped by directed_at_me', async () => {
  const spies = mockAllUnconfigured();
  db.prepare(`
    INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
    VALUES (@id, 'teams', @title, @participants, @occurredAt, @bodyText)
  `).run({
    id: 'teams-test:reply-needed',
    title: 'Design meeting',
    participants: JSON.stringify(['Alice']),
    occurredAt: new Date().toISOString(), // fresh -> urgency 5
    bodyText: 'Can you review the doc before EOD?',
  });
  db.prepare(`
    INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
    VALUES (@id, 'teams', @title, @participants, @occurredAt, @bodyText)
  `).run({
    id: 'teams-test:fyi',
    title: 'gDEV',
    participants: JSON.stringify(['Bob']),
    occurredAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days old -> urgency 2
    bodyText: 'FYI the build is green.',
  });
  db.prepare(`
    INSERT INTO teams_message_triage (message_id, directed_at_me, summary, draft_reply)
    VALUES (@messageId, @directedAtMe, @summary, @draftReply)
  `).run({ messageId: 'teams-test:reply-needed', directedAtMe: 1, summary: 'Alice wants the doc reviewed by end of day.', draftReply: "Sure, I'll take a look shortly." });
  db.prepare(`
    INSERT INTO teams_message_triage (message_id, directed_at_me, summary, draft_reply)
    VALUES (@messageId, @directedAtMe, @summary, @draftReply)
  `).run({ messageId: 'teams-test:fyi', directedAtMe: 0, summary: 'The build is green.', draftReply: null });

  try {
    await syncTasks();
    const tasks = getOpenTasks().filter((t) => t.source === 'teams_message');

    const replyTask = tasks.find((t) => t.externalRef === 'teams-test:reply-needed');
    assert.ok(replyTask);
    assert.match(replyTask!.title, /^Reply needed: Design meeting$/);
    assert.equal(replyTask!.importanceScore, 4);
    assert.equal(replyTask!.urgencyScore, 5);
    assert.equal(replyTask!.draftReply, "Sure, I'll take a look shortly.");

    const fyiTask = tasks.find((t) => t.externalRef === 'teams-test:fyi');
    assert.ok(fyiTask);
    assert.match(fyiTask!.title, /^FYI: gDEV$/);
    assert.equal(fyiTask!.importanceScore, 2);
    assert.equal(fyiTask!.urgencyScore, 2);
    assert.equal(fyiTask!.draftReply, null);
  } finally {
    spies.forEach((s) => s.mock.restore());
    db.prepare(`DELETE FROM teams_message_triage WHERE message_id IN ('teams-test:reply-needed', 'teams-test:fyi')`).run();
    db.prepare(`DELETE FROM external_messages WHERE id IN ('teams-test:reply-needed', 'teams-test:fyi')`).run();
  }
});

test('syncTasks: a Bitbucket review request already approved by me is skipped, and pruned if previously synced', async () => {
  const spies = [
    mock.method(jiraMcp, 'isJiraConfigured', () => false),
    mock.method(bitbucketServer, 'isBitbucketConfigured', () => true),
    mock.method(bitbucketReviews, 'getPullRequestActivity', async () => ({
      reviewRequests: [
        { id: 43, title: 'Already approved PR', state: 'OPEN', projectKey: 'PROJ', repoSlug: 'repo', authorName: 'alice', link: 'https://bitbucket.example/PROJ/repo/pr/43', myApprovalStatus: 'APPROVED', createdDate: new Date().toISOString() },
      ],
      commentsOnMyPRs: [],
      mentionsOfMe: [],
    })),
    mock.method(summaryRepository, 'getAllOpenActionItems', () => []),
  ];
  try {
    await syncTasks();
    const tasks = getOpenTasks().filter((t) => t.source === 'bitbucket_pr' && t.externalRef === 'PROJ/repo#43');
    assert.equal(tasks.length, 0);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('syncTasks: triaged emails become email_message tasks with recency-based urgency and title shaped by needs_reply', async () => {
  const spies = mockAllUnconfigured();
  db.prepare(`
    INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
    VALUES (@id, 'email', @title, @participants, @occurredAt, @bodyText)
  `).run({
    id: 'email-test:reply-needed',
    title: 'Quarterly report',
    participants: JSON.stringify(['alice@example.com']),
    occurredAt: new Date().toISOString(), // fresh -> urgency 5
    bodyText: 'Can you send me the numbers by Friday?',
  });
  db.prepare(`
    INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
    VALUES (@id, 'email', @title, @participants, @occurredAt, @bodyText)
  `).run({
    id: 'email-test:fyi',
    title: 'Weekly newsletter',
    participants: JSON.stringify(['news@example.com']),
    occurredAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days old -> urgency 2
    bodyText: 'This week in tech...',
  });
  db.prepare(`
    INSERT INTO email_message_triage (message_id, needs_reply, summary, draft_reply)
    VALUES (@messageId, @needsReply, @summary, @draftReply)
  `).run({ messageId: 'email-test:reply-needed', needsReply: 1, summary: 'Alice needs the quarterly numbers by Friday.', draftReply: "Hi Alice, I'll get you the numbers by Friday." });
  db.prepare(`
    INSERT INTO email_message_triage (message_id, needs_reply, summary, draft_reply)
    VALUES (@messageId, @needsReply, @summary, @draftReply)
  `).run({ messageId: 'email-test:fyi', needsReply: 0, summary: 'Weekly tech newsletter.', draftReply: null });

  try {
    await syncTasks();
    const tasks = getOpenTasks().filter((t) => t.source === 'email_message');

    const replyTask = tasks.find((t) => t.externalRef === 'email-test:reply-needed');
    assert.ok(replyTask);
    assert.match(replyTask!.title, /^Reply needed: Quarterly report$/);
    assert.equal(replyTask!.importanceScore, 4);
    assert.equal(replyTask!.urgencyScore, 5);
    assert.equal(replyTask!.draftReply, "Hi Alice, I'll get you the numbers by Friday.");

    const fyiTask = tasks.find((t) => t.externalRef === 'email-test:fyi');
    assert.ok(fyiTask);
    assert.match(fyiTask!.title, /^FYI: Weekly newsletter$/);
    assert.equal(fyiTask!.importanceScore, 2);
    assert.equal(fyiTask!.urgencyScore, 2);
    assert.equal(fyiTask!.draftReply, null);
  } finally {
    spies.forEach((s) => s.mock.restore());
    db.prepare(`DELETE FROM email_message_triage WHERE message_id IN ('email-test:reply-needed', 'email-test:fyi')`).run();
    db.prepare(`DELETE FROM external_messages WHERE id IN ('email-test:reply-needed', 'email-test:fyi')`).run();
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
    assert.deepEqual(result.synced.sort(), ['action_items', 'bitbucket', 'email_messages', 'jenkins', 'teams_messages']);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('syncTasks: a currently-failing Jenkins build becomes a jenkins_build task, pruned once it goes green', async () => {
  const spies = mockAllUnconfigured();
  const jenkinsSpy = mock.method(jenkinsClientModule, 'isJenkinsConfigured', () => true);
  const failingSpy = mock.method(jenkinsBuildRepositoryModule, 'getCurrentFailingBuilds', () => [
    {
      id: 1, devCycleId: null, jobPath: '/job/x', branchName: 'feature/PROJ-1-x', buildNumber: 9, result: 'FAILURE' as const,
      building: false, url: 'https://jenkins/9', startedAt: null, classification: 'compile_error' as const,
      classificationJson: { summary: 'Compile error in src/foo.ts' }, logExcerpt: null, notified: true, createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
  try {
    const result = await syncTasks();
    assert.ok(result.synced.includes('jenkins'));
    const tasks = getOpenTasks().filter((t) => t.source === 'jenkins_build');
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /feature\/PROJ-1-x/);
    assert.equal(tasks[0].description, 'Compile error in src/foo.ts');
  } finally {
    spies.forEach((s) => s.mock.restore());
    jenkinsSpy.mock.restore();
    failingSpy.mock.restore();
  }
});

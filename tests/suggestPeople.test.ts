import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/storage/db';
import { createPerson } from '../src/storage/peopleRepository';
import * as bitbucketServerModule from '../src/integrations/bitbucketServer';
import * as bitbucketReviewsModule from '../src/integrations/bitbucketReviews';
import * as jiraMcpModule from '../src/integrations/jiraMcp';
import * as teamsMessageTriageModule from '../src/communications/teamsMessageTriage';
import { getPeopleSuggestions } from '../src/people/suggestPeople';

function seedExternalMessage(id: string, source: 'teams' | 'email', sender: string) {
  db.prepare(
    `INSERT INTO external_messages (id, source, title, participants, occurred_at, body_text)
     VALUES (@id, @source, 'Subject', @participants, datetime('now'), 'body')`
  ).run({ id, source, participants: JSON.stringify([sender]) });
}

function cleanupMessages(ids: string[]) {
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM external_messages WHERE id IN (${placeholders})`).run(...ids);
}

function mockAllUnconfigured() {
  return [
    mock.method(bitbucketServerModule, 'isBitbucketConfigured', () => false),
    mock.method(teamsMessageTriageModule, 'detectMyTeamsDisplayName', () => null),
  ];
}

test('getPeopleSuggestions: surfaces Teams/email senders not already in the directory', async () => {
  const spies = mockAllUnconfigured();
  seedExternalMessage('suggest-test:1', 'teams', 'Nina Suggest Test');
  seedExternalMessage('suggest-test:2', 'email', 'oscar.suggest.test@example.com');
  try {
    const suggestions = await getPeopleSuggestions();
    assert.ok(suggestions.includes('Nina Suggest Test'));
    assert.ok(suggestions.includes('oscar.suggest.test@example.com'));
  } finally {
    spies.forEach((s) => s.mock.restore());
    cleanupMessages(['suggest-test:1', 'suggest-test:2']);
  }
});

test('getPeopleSuggestions: excludes the detected "my own" Teams display name', async () => {
  const spies = [
    mock.method(bitbucketServerModule, 'isBitbucketConfigured', () => false),
    mock.method(teamsMessageTriageModule, 'detectMyTeamsDisplayName', () => 'Me Suggest Test'),
  ];
  seedExternalMessage('suggest-test:3', 'teams', 'Me Suggest Test');
  seedExternalMessage('suggest-test:4', 'teams', 'Priya Suggest Test');
  try {
    const suggestions = await getPeopleSuggestions();
    assert.ok(!suggestions.includes('Me Suggest Test'));
    assert.ok(suggestions.includes('Priya Suggest Test'));
  } finally {
    spies.forEach((s) => s.mock.restore());
    cleanupMessages(['suggest-test:3', 'suggest-test:4']);
  }
});

test('getPeopleSuggestions: excludes names already in the people directory (case-insensitive)', async () => {
  const spies = mockAllUnconfigured();
  createPerson({ displayName: 'quinn suggest test' });
  seedExternalMessage('suggest-test:5', 'teams', 'Quinn Suggest Test');
  try {
    const suggestions = await getPeopleSuggestions();
    assert.ok(!suggestions.includes('Quinn Suggest Test'));
  } finally {
    spies.forEach((s) => s.mock.restore());
    cleanupMessages(['suggest-test:5']);
  }
});

test('getPeopleSuggestions: includes Bitbucket authors when configured', async () => {
  const spies = [
    mock.method(bitbucketServerModule, 'isBitbucketConfigured', () => true),
    mock.method(bitbucketReviewsModule, 'getPullRequestActivity', async () => ({
      reviewRequests: [{ authorName: 'Rosa Bitbucket Test' }],
      mentionsOfMe: [],
      commentsOnMyPRs: [],
    })),
    mock.method(teamsMessageTriageModule, 'detectMyTeamsDisplayName', () => null),
  ];
  try {
    const suggestions = await getPeopleSuggestions();
    assert.ok(suggestions.includes('Rosa Bitbucket Test'));
  } finally {
    spies.forEach((s) => s.mock.restore());
  }
});

test('getPeopleSuggestions: includes Jira comment authors when jiraUserIdentifier is set', async () => {
  const prevJiraUser = process.env.JIRA_USER_IDENTIFIER;
  process.env.JIRA_USER_IDENTIFIER = 'me@example.com';
  const spies = [
    mock.method(bitbucketServerModule, 'isBitbucketConfigured', () => false),
    mock.method(jiraMcpModule, 'getJiraCommentMentions', async () => [
      { issueKey: 'ETICK-1', issueSummary: 's', priorityName: null, commentId: '1', authorName: 'Sam Jira Test', text: 't', createdDate: new Date().toISOString(), url: 'https://jira.example/ETICK-1' },
    ]),
    mock.method(teamsMessageTriageModule, 'detectMyTeamsDisplayName', () => null),
  ];
  try {
    const suggestions = await getPeopleSuggestions();
    assert.ok(suggestions.includes('Sam Jira Test'));
  } finally {
    if (prevJiraUser === undefined) delete process.env.JIRA_USER_IDENTIFIER;
    else process.env.JIRA_USER_IDENTIFIER = prevJiraUser;
    spies.forEach((s) => s.mock.restore());
  }
});

test('getPeopleSuggestions: deduplicates the same name across sources, sorted alphabetically', async () => {
  const spies = mockAllUnconfigured();
  seedExternalMessage('suggest-test:6', 'teams', 'Zoe Dedup Test');
  seedExternalMessage('suggest-test:7', 'email', 'zoe dedup test');
  seedExternalMessage('suggest-test:8', 'teams', 'Anna Dedup Test');
  try {
    const suggestions = await getPeopleSuggestions();
    const zoeCount = suggestions.filter((n) => n.toLowerCase() === 'zoe dedup test').length;
    assert.equal(zoeCount, 1);
    const annaIdx = suggestions.indexOf('Anna Dedup Test');
    const zoeIdx = suggestions.findIndex((n) => n.toLowerCase() === 'zoe dedup test');
    assert.ok(annaIdx < zoeIdx);
  } finally {
    spies.forEach((s) => s.mock.restore());
    cleanupMessages(['suggest-test:6', 'suggest-test:7', 'suggest-test:8']);
  }
});

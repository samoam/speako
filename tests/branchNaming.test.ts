import test from 'node:test';
import assert from 'node:assert/strict';
import { branchTypeForIssueType, slugify, buildBranchName, extractTicketKeyFromBranch, parseBranchName } from '../src/dev/branchNaming';

test('branchTypeForIssueType: Bug/Defect -> bugfix', () => {
  assert.equal(branchTypeForIssueType('Bug'), 'bugfix');
  assert.equal(branchTypeForIssueType('defect'), 'bugfix');
});

test('branchTypeForIssueType: Task/Chore/Sub-task -> chore', () => {
  assert.equal(branchTypeForIssueType('Task'), 'chore');
  assert.equal(branchTypeForIssueType('Chore'), 'chore');
  assert.equal(branchTypeForIssueType('Sub-task'), 'chore');
});

test('branchTypeForIssueType: Story/Epic/unrecognized -> feature', () => {
  assert.equal(branchTypeForIssueType('Story'), 'feature');
  assert.equal(branchTypeForIssueType('Epic'), 'feature');
  assert.equal(branchTypeForIssueType('Something Weird'), 'feature');
});

test('branchTypeForIssueType: never returns hotfix (always an explicit human choice)', () => {
  for (const t of ['Bug', 'Task', 'Story', 'Epic', 'hotfix', 'Hotfix']) {
    assert.notEqual(branchTypeForIssueType(t), 'hotfix');
  }
});

test('slugify: lowercases, strips a leading ticket-key prefix, and hyphenates', () => {
  assert.equal(slugify('PROJ-1234: Add OAuth refresh'), 'add-oauth-refresh');
  assert.equal(slugify('proj-1234 Add OAuth refresh'), 'add-oauth-refresh');
});

test('slugify: strips a leading bracketed tag', () => {
  assert.equal(slugify('[BE] Fix null session'), 'fix-null-session');
});

test('slugify: collapses non-alnum runs to single hyphens and trims edges', () => {
  assert.equal(slugify('  Fix   the!! bug...  '), 'fix-the-bug');
});

test('slugify: falls back to "changes" for an empty result', () => {
  assert.equal(slugify('###'), 'changes');
  assert.equal(slugify(''), 'changes');
});

test('slugify: truncates at the last hyphen before maxLength, never mid-word', () => {
  const long = 'this is a very long summary that keeps going and going and going on';
  const result = slugify(long, 20);
  assert.ok(result.length <= 20);
  assert.ok(!result.endsWith('-'));
  // Every word in the result must be a complete word from the source, not a fragment.
  const words = long.toLowerCase().split(/\s+/);
  for (const part of result.split('-')) assert.ok(words.includes(part), `"${part}" should be a whole word`);
});

test('buildBranchName: <type>/<TICKET-ID>-<slug>, ticket key uppercased', () => {
  assert.equal(buildBranchName({ type: 'feature', ticketKey: 'proj-1234', summary: 'Add OAuth refresh' }), 'feature/PROJ-1234-add-oauth-refresh');
  assert.equal(buildBranchName({ type: 'bugfix', ticketKey: 'PROJ-987', summary: 'Fix null session' }), 'bugfix/PROJ-987-fix-null-session');
});

test('buildBranchName: total length capped at 100 chars', () => {
  const branch = buildBranchName({ type: 'feature', ticketKey: 'PROJ-1', summary: 'a'.repeat(300) });
  assert.ok(branch.length <= 100);
});

test('extractTicketKeyFromBranch: finds the ticket key in a properly-named branch', () => {
  assert.equal(extractTicketKeyFromBranch('feature/PROJ-1234-add-oauth-refresh'), 'PROJ-1234');
  assert.equal(extractTicketKeyFromBranch('bugfix/ETICK-42-fix-thing'), 'ETICK-42');
});

test('extractTicketKeyFromBranch: null for a branch with no ticket key', () => {
  assert.equal(extractTicketKeyFromBranch('main'), null);
  assert.equal(extractTicketKeyFromBranch('feature/some-random-branch'), null);
});

test('parseBranchName: round-trips a well-formed branch name', () => {
  assert.deepEqual(parseBranchName('feature/PROJ-1234-add-oauth-refresh'), { type: 'feature', ticketKey: 'PROJ-1234', slug: 'add-oauth-refresh' });
});

test('parseBranchName: null for a non-conforming branch name', () => {
  assert.equal(parseBranchName('main'), null);
  assert.equal(parseBranchName('random/PROJ-1234-thing'), null);
});
